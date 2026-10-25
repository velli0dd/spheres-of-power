/**
 * Сборка компендиумов сфер и талантов из Markdown.
 *
 *   src/spheres.json             — справочник сфер (id → русское/английское название)
 *   src/spheres/<id>/*.md        — перевод сферы (файлы читаются по алфавиту)
 *
 * Результат: packs-src/spheres и packs-src/magic-talents (JSON для `fvtt package pack`).
 * Формат Markdown описан в src/README.md.
 *
 * Запуск: npm run build   (только JSON)
 *         npm run pack    (JSON + сборка LevelDB; Foundry должен быть закрыт)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "packs-src");
const MODULE_ID = "spheres-of-power";

const PACKS = { sphere: "spheres", talent: "magic-talents" };
const DEFAULT_IMG = "systems/dnd5e/icons/svg/items/feature.svg";
const STATS = { coreVersion: "14.361", systemId: "dnd5e", systemVersion: "5.3.3" };

/** Подписи к типам талантов: добавляются к названию в скобках, как в книге. */
const KIND_LABELS = JSON.parse(fs.readFileSync(path.join(SRC, "talent-kinds.json"), "utf8"));
const SPHERES = JSON.parse(fs.readFileSync(path.join(SRC, "spheres.json"), "utf8"));

const warnings = [];
const errors = [];
const warn = msg => warnings.push(msg);
const error = msg => errors.push(msg);

/* -------------------------------------------- */
/*  ID: детерминированные, чтобы @UUID-ссылки   */
/*  не ломались при пересборке                  */
/* -------------------------------------------- */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function stableId(...parts) {
    const hash = crypto.createHash("sha256").update(parts.join("/")).digest();
    let id = "";
    for (let i = 0; i < 16; i++) id += ALPHABET[hash[i] % ALPHABET.length];
    return id;
}

const itemId = (sphere, id) => id === sphere ? stableId("sphere", sphere) : stableId("talent", sphere, id);
const folderId = (...path) => stableId("folder", ...path);

/* -------------------------------------------- */
/*  Разбор Markdown                             */
/* -------------------------------------------- */

const META_RE = /^([a-z_]+):\s*(.*)$/;

/**
 * Делит файл на элементы. `# Заголовок` задаёт папку для следующих элементов,
 * `## Заголовок` начинает новый элемент, строки `ключ: значение` сразу под ним — его поля.
 */
function parseFile(file, sphereId) {
    const lines = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n").split("\n");
    const items = [];
    let folder = null;
    let current = null;
    let inMeta = false;
    let inComment = false;

    lines.forEach((line, i) => {
        // HTML-комментарии <!-- --> — заметки переводчика, в Foundry не попадают
        if (inComment) {
            if (line.includes("-->")) inComment = false;
            return;
        }
        if (/^\s*<!--/.test(line)) {
            if (!line.includes("-->")) inComment = true;
            return;
        }

        const h1 = line.match(/^#\s+(.+)$/);
        const h2 = line.match(/^##\s+(.+)$/);
        if (h1) {
            folder = h1[1].trim();
            current = null;
            return;
        }
        if (h2) {
            current = { name: h2[1].trim(), meta: {}, body: [], folder, file, line: i + 1, sphere: sphereId };
            items.push(current);
            inMeta = true;
            return;
        }
        if (!current) {
            if (line.trim()) warn(`${rel(file)}:${i + 1}: текст вне элемента пропущен`);
            return;
        }
        const m = inMeta && line.match(META_RE);
        if (m) {
            current.meta[m[1]] = m[2].trim();
            return;
        }
        inMeta = false;
        current.body.push(line);
    });

    return items;
}

/* -------------------------------------------- */
/*  Markdown → HTML                             */
/* -------------------------------------------- */

function inline(text, ctx) {
    return text
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>")
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, ref, label) => link(ref.trim(), label?.trim(), ctx));
}

/**
 * [[id]] — талант этой же сферы, [[сфера:id]] — талант другой сферы,
 * [[сфера:]] — сама сфера. Если цели ещё нет в сборке — остаётся простой текст.
 */
function link(ref, label, ctx) {
    const [sphere, id] = ref.includes(":") ? ref.split(":") : [ctx.item.sphere, ref];
    const targetId = id || sphere;
    const target = ctx.index.get(`${sphere}:${targetId}`);
    const text = label ?? target?.name ?? SPHERES[sphere]?.ru ?? targetId;
    if (!target) {
        ctx.pending.add(`${sphere}:${targetId}`);
        return text;
    }
    return `@UUID[Compendium.${MODULE_ID}.${target.pack}.Item.${target._id}]{${text}}`;
}

function toHtml(lines, ctx) {
    const html = [];
    let para = [];
    let list = null;

    const flushPara = () => {
        if (para.length) html.push(`<p>${inline(para.join(" "), ctx)}</p>`);
        para = [];
    };
    const flushList = () => {
        if (list) html.push(`<ul>${list.map(li => `<li>${inline(li, ctx)}</li>`).join("")}</ul>`);
        list = null;
    };

    for (const raw of lines) {
        const line = raw.trim();
        const h3 = line.match(/^###\s+(.+)$/);
        const li = line.match(/^[-•]\s+(.+)$/);
        if (!line) {
            flushPara();
            flushList();
        } else if (h3) {
            flushPara();
            flushList();
            html.push(`<h3>${inline(h3[1], ctx)}</h3>`);
        } else if (li) {
            flushPara();
            (list ??= []).push(li[1]);
        } else if (list) {
            list[list.length - 1] += " " + line;
        } else {
            para.push(line);
        }
    }
    flushPara();
    flushList();
    return html.join("");
}

/* -------------------------------------------- */
/*  Документы Foundry                           */
/* -------------------------------------------- */

/** Папка сферы хранит подпапки в порядке файлов («m»), внутри подпапок — по алфавиту. */
function folderDoc(id, name, parent, sort) {
    return {
        type: "Item", folder: parent, name, color: null, sorting: parent ? "a" : "m", _id: id,
        description: "", sort, flags: {}, _stats: { ...STATS }, _key: `!folders!${id}`
    };
}

function itemDoc(item, ctx) {
    const { meta } = item;
    const isSphere = item.kind === "sphere";
    const sphereName = SPHERES[item.sphere]?.ru ?? item.sphere;

    const requirements = isSphere ? ""
        : meta.prereq ?? (meta.assoc
            ? `${sphereName}; бесплатно со сферой ${SPHERES[meta.assoc]?.ru ?? meta.assoc}`
            : sphereName);

    return {
        name: item.fullName,
        type: "feat",
        _id: item._id,
        img: meta.img ?? DEFAULT_IMG,
        folder: item.folderId,
        system: {
            activities: {},
            uses: { spent: 0, recovery: [], max: "" },
            advancement: {},
            description: { value: toHtml(item.body, { ...ctx, item }), chat: "" },
            identifier: isSphere ? item.sphere : `${item.sphere}-${meta.id}`,
            source: {
                revision: 1, rules: "2024", book: "Spheres of Power 5e",
                page: meta.page ?? "", custom: "", license: ""
            },
            crewed: false,
            enchant: {},
            prerequisites: { items: [], repeatable: meta.repeatable === "да", level: meta.level ? Number(meta.level) : null },
            properties: [],
            requirements,
            type: { value: "sphere", subtype: isSphere ? "sphere" : "talent" }
        },
        effects: [],
        sort: item.sort,
        ownership: { default: 0 },
        flags: {
            [MODULE_ID]: {
                sphere: item.sphere,
                talent: isSphere ? null : meta.id,
                kind: meta.kind ?? null,
                advanced: meta.advanced === "да",
                associatedSphere: meta.assoc ?? null,
                tags: meta.tags ? meta.tags.split(",").map(t => t.trim()) : [],
                en: meta.en ?? null
            }
        },
        _stats: { ...STATS },
        _key: `!items!${item._id}`
    };
}

/* -------------------------------------------- */
/*  Сборка                                      */
/* -------------------------------------------- */

const rel = p => path.relative(ROOT, p).replaceAll("\\", "/");

function safeName(name) {
    return name.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, "_");
}

function collect() {
    const items = [];
    const dir = path.join(SRC, "spheres");
    for (const sphereId of fs.readdirSync(dir).sort()) {
        const sphereDir = path.join(dir, sphereId);
        if (!fs.statSync(sphereDir).isDirectory()) continue;
        if (!SPHERES[sphereId]) warn(`src/spheres/${sphereId}: сферы нет в src/spheres.json`);
        for (const f of fs.readdirSync(sphereDir).filter(f => f.endsWith(".md")).sort()) {
            items.push(...parseFile(path.join(sphereDir, f), sphereId));
        }
    }
    return items;
}

function validate(items) {
    const seen = new Map();
    for (const item of items) {
        const where = `${rel(item.file)}:${item.line} «${item.name}»`;
        if (!item.meta.id) error(`${where}: нет поля id`);
        else if (!/^[a-z0-9-]+$/.test(item.meta.id)) error(`${where}: id должен быть латиницей в kebab-case`);
        const key = `${item.sphere}:${item.meta.id}`;
        if (seen.has(key)) error(`${where}: id «${item.meta.id}» уже занят (${seen.get(key)})`);
        seen.set(key, where);
        if (item.meta.kind && item.meta.kind !== "sphere" && !KIND_LABELS[item.meta.kind]) {
            warn(`${where}: неизвестный kind «${item.meta.kind}» — добавьте его в src/talent-kinds.json`);
        }
        if (item.meta.assoc && !SPHERES[item.meta.assoc]) warn(`${where}: неизвестная сфера в assoc «${item.meta.assoc}»`);
        if (!item.body.some(l => l.trim())) warn(`${where}: пустое описание`);
        for (const l of item.body) {
            if (/[A-Za-z]{4,}/.test(l.replace(/\[\[[^\]]*\]\]/g, ""))) {
                warn(`${where}: латиница в тексте — непереведённый фрагмент? «${l.trim().slice(0, 60)}»`);
                break;
            }
        }
    }
}

function build() {
    const items = collect();
    validate(items);
    if (errors.length) {
        console.log(`Ошибки (${errors.length}), сборка остановлена:`);
        for (const e of errors) console.log("  • " + e);
        process.exitCode = 1;
        return;
    }

    const docs = { spheres: [], "magic-talents": [] };
    const folderPaths = new Map(); // id → путь к папке на диске
    const index = new Map();       // "сфера:id" → { _id, pack, name }

    // Первый проход: id, папки, названия — чтобы ссылки работали в любом направлении
    const sortCounters = new Map();
    for (const item of items) {
        item.kind = item.meta.kind === "sphere" ? "sphere" : "talent";
        item.pack = PACKS[item.kind];
        item._id = item.kind === "sphere" ? itemId(item.sphere, item.sphere) : itemId(item.sphere, item.meta.id);

        const label = KIND_LABELS[item.meta.kind];
        item.fullName = label ? `${item.name} (${label})` : item.name;

        if (item.kind === "talent") {
            const sphereName = SPHERES[item.sphere]?.ru ?? item.sphere;
            const rootId = folderId(item.sphere);
            if (!folderPaths.has(rootId)) {
                const order = Object.keys(SPHERES).indexOf(item.sphere);
                docs["magic-talents"].push(folderDoc(rootId, sphereName, null, (order + 1) * 100000));
                folderPaths.set(rootId, `${safeName(sphereName)}_${rootId}`);
            }
            item.folderId = rootId;
            if (item.folder) {
                const subId = folderId(item.sphere, item.folder);
                if (!folderPaths.has(subId)) {
                    const n = [...folderPaths.keys()].length;
                    docs["magic-talents"].push(folderDoc(subId, item.folder, rootId, n * 100000));
                    folderPaths.set(subId, `${folderPaths.get(rootId)}/${safeName(item.folder)}_${subId}`);
                }
                item.folderId = subId;
            }
        } else {
            item.folderId = null;
        }

        const n = (sortCounters.get(item.folderId) ?? 0) + 1;
        sortCounters.set(item.folderId, n);
        item.sort = n * 100000;

        index.set(`${item.sphere}:${item.kind === "sphere" ? item.sphere : item.meta.id}`,
            { _id: item._id, pack: item.pack, name: item.fullName });
    }

    // Второй проход: документы
    const pending = new Set();
    for (const item of items) {
        docs[item.pack].push(itemDoc(item, { index, pending }));
    }

    // Запись
    for (const [pack, list] of Object.entries(docs)) {
        const dir = path.join(OUT, pack);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        for (const doc of list) {
            let file;
            if (doc._key.startsWith("!folders!")) {
                file = path.join(dir, folderPaths.get(doc._id), "_Folder.json");
            } else {
                const sub = doc.folder ? folderPaths.get(doc.folder) : "";
                file = path.join(dir, sub, `${safeName(doc.name)}_${doc._id}.json`);
            }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
        }
        console.log(`${pack}: ${list.filter(d => d._key.startsWith("!items!")).length} элементов`);
    }

    if (pending.size) {
        console.log(`\nСсылки на ещё не переведённое (пока простой текст): ${[...pending].sort().join(", ")}`);
    }
    if (warnings.length) {
        console.log(`\nПредупреждения (${warnings.length}):`);
        for (const w of warnings) console.log("  • " + w);
    }
}

build();
