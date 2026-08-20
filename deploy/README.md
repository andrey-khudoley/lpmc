# deploy/ — развёртывание узла LPMC

Здесь живёт то, что превращает **собранный** код в **работающий** узел: роль
`lpmc_system` и playbook, который её применяет. Роль приносит с собой всё, что
нужно системе, — PostgreSQL, NATS JetStream, egress-proxy, браузерный стек и
контур просмотра экрана; единственная внешняя зависимость — nginx (общая роль),
который отдаёт наружу одноразовый путь к сеансу просмотра.

## Раскладка

```
roles/lpmc_system/   роль развёртывания: tasks, templates (systemd-юниты,
                     nats/nftables/nginx-конфиги), defaults, handlers
playbooks/deploy.yml плейбук: применяет роль к группе хостов `lpmc`
inventory/           инвентари: local.ini (текущий узел) и hosts.example.ini
NODE-LAYOUT.md       раскладка каталогов узла (/var/lib/lpmc-system/…)
```

Код контуров и компонентов роль берёт из **этого же репозитория**
(`lpmc_system_src_dir`, по умолчанию — корень репо): синхронизирует его в
`/usr/local/lib/lpmc`, ставит зависимости (`npm ci`), собирает (`npm run build`)
и применяет миграции. egress-proxy (`@lpmc/egress`) и привратник просмотра
(`@lpmc/view`) живут в `packages/` и собираются автономно из того же источника.

## Развёртывание

Предпосылки на узле: поддерживаемый дистрибутив (dnf-семейство), доступ к
`sudo`, сеть до npm/GitHub на время сборки. Роль идемпотентна — повторный прогон
меняет только то, что изменилось в коде или конфигурации.

```bash
# 1. Инвентарь: для нового узла скопируйте пример и впишите хост.
cp deploy/inventory/hosts.example.ini deploy/inventory/hosts.ini
#    (для текущего узла уже готов deploy/inventory/local.ini — localhost)

# 2. Значения узла (домен и сертификаты внешнего пути human-view) НЕ хранятся
#    в git. Подготовьте файл переменных вне репозитория:
cat > /path/vне-репо/lpmc-vars.yml <<'YAML'
lpmc_system_public_domain: example.tld
lpmc_system_public_port: 22326
lpmc_system_public_cert: /etc/letsencrypt/live/example.tld/fullchain.pem
lpmc_system_public_cert_key: /etc/letsencrypt/live/example.tld/privkey.pem
YAML

# 3. Прогон роли из репозитория.
sudo ANSIBLE_ROLES_PATH="$PWD/deploy/roles" ansible-playbook \
  -i deploy/inventory/local.ini deploy/playbooks/deploy.yml \
  -e @/path/vне-репо/lpmc-vars.yml
```

После прогона на узле работают сервисы (`systemctl list-units 'lpmc-*'`): брокер
`lpmc-nats`, ретрансляторы `lpmc-relay@{lina,pact,mita,cita}`, арбитр
`lpmc-pact@{intaked,leased,egressd,runsd,approvald,ingestd,reviewsd}`,
квалификатор `lpmc-dispatch@qualifierd`, доставка `lpmc-lina@deliveryd`,
исполнители `lpmc-{mita,cita}@{runnerd,ownersd}`, egress-proxy `lpmc-egress`,
браузер `lpmc-browser@<владелец>` и контур просмотра `lpmc-view`.

## Диалог с системой после развёртывания

```bash
lpmc-tui           # интерактивный диалог с Линой (обёртка ставится ролью)
```

Подробнее — `packages/tui/README.md`.

## Границы: чего здесь нет — намеренно

- **Секретов, `storage_state`, паролей, allowlist с учётными данными** — они живут
  вне репозитория и вне его резервных копий (ADR-0011/0012 контура MITA). Главный
  ключ шифрования, ключ подписи PACT и nkey-сиды брокера **генерируются ролью на
  узле**, а не берутся из git.
- **Значений конкретного узла** (внешний домен, порт, пути к сертификатам) — они
  передаются через `-e`, как показано выше.
- **Общих серверных ролей** (nginx, security_hardening, base_system…) — они общие
  с другими проектами и подключаются из инфра-репозитория, а не дублируются здесь.
