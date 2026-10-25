/**
 * Выпуск новой версии модуля.
 *
 *   npm run release 1.0.1
 *
 * Меняет version и download в module.json, коммитит, ставит тег v1.0.1 и отправляет
 * всё на GitHub. Foundry увидит обновление по ссылке manifest (через несколько минут —
 * GitHub кэширует raw-файлы).
 *
 * Перед выпуском: закройте Foundry, выполните `npm run pack` и закоммитьте изменения —
 * скрипт откажется работать, если есть незакоммиченные файлы.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "module.json");
const REPO = "https://github.com/velli0dd/spheres-of-power";

const git = cmd => execSync(`git ${cmd}`, { cwd: ROOT, encoding: "utf8" }).trim();
const fail = msg => {
    console.log(msg);
    process.exit(1);
};

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) fail("Укажите версию: npm run release 1.0.1");

if (git("status --porcelain")) fail("Есть незакоммиченные изменения — сначала закоммитьте их.");
if (git(`tag --list v${version}`)) fail(`Тег v${version} уже существует.`);

// Правим текстом, а не через JSON.stringify, чтобы не переформатировать файл
let text = fs.readFileSync(MANIFEST, "utf8");
const current = text.match(/"version":\s*"([^"]+)"/)?.[1];
text = text
    .replace(/("version":\s*")[^"]+(")/, `$1${version}$2`)
    .replace(/("download":\s*")[^"]+(")/, `$1${REPO}/archive/refs/tags/v${version}.zip$2`);
fs.writeFileSync(MANIFEST, text);

git("add module.json");
git(`commit -m "Версия ${version}"`);
git(`tag -a v${version} -m "Версия ${version}"`);
console.log(`${current} → ${version}, отправка на GitHub…`);
console.log(git("push origin HEAD --follow-tags"));
console.log(`Готово: ${REPO}/releases/tag/v${version}`);
