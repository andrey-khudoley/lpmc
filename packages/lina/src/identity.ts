import type { AdapterIdentity } from "./adapter.js";

/**
 * Личность канального адаптера. Задана в коде, а не в конфигурации: значение
 * сверяется при каждой доставке, и возможность подменить его настройкой означала
 * бы возможность выдать себя за чужой адаптер правкой файла.
 */
export const CLI_ADAPTER: AdapterIdentity = { channel: "cli", adapterId: "lina-cli" };
