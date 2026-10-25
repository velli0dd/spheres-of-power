const MODULE_ID = "spheres-of-power";
const { SchemaField, NumberField } = foundry.data.fields;

import {
    hasAddictiveCastingDrawback,
    injectAddictionPips
} from "./addictive-casting.js";

const TEMPLATE_DIR = `modules/${MODULE_ID}/templates/actors`;

/* -------------------------------------------- */
/*  Data model                                  */
/* -------------------------------------------- */

export class SpheresCharacterData extends dnd5e.dataModels.actor.CharacterData {

    static defineSchema() {
        const schema = super.defineSchema();

        schema.spheres = new SchemaField({
            spellPoints: new SchemaField({
                value: new NumberField({ initial: 0, min: 0, integer: true }),
                max: new NumberField({ initial: 0, min: 0, integer: true }),
                bonus: new NumberField({ initial: 0, integer: true })
            }),
            casterLevel: new NumberField({ initial: 0, min: 0, integer: true }),
            addiction: new SchemaField({
                level: new NumberField({ initial: 0, min: 0, integer: true }),
                dc: new NumberField({ initial: 8, min: 8, integer: true })
            })
        });

        return schema;
    }

    prepareBaseData() {
        super.prepareBaseData();
        this.spheres.casterLevel = this._computeSphereCasterLevel();
    }

    /**
     * Уровень заклинателя считается по правилам из CONFIG.DND5E.spellcasting.sphere
     * (divisor / roundUp) — конфиг остаётся единственным источником правды.
     * Если нужно округление вниз у половинного заклинателя, поставь roundUp: false в конфиге.
     */
    _computeSphereCasterLevel() {
        const progressions = CONFIG.DND5E.spellcasting.sphere?.progression ?? {};
        let cl = 0;

        for (const cls of this.parent.items) {
            if (cls.type !== "class") continue;
            const cfg = progressions[cls.system.spellcasting?.progression];
            if (!cfg) continue;

            const round = cfg.roundUp ? Math.ceil : Math.floor;
            cl += round((cls.system.levels ?? 0) / (cfg.divisor || 1));
        }
        return cl;
    }

    prepareDerivedData() {
        super.prepareDerivedData();

        // Очки заклинаний
        // max в данных — базовый максимум; здесь он становится итоговым (база + бонус).
        // Базовое значение для диалога берётся из actor._source.
        const sp = this.spheres.spellPoints;
        const baseMax = Math.max(0, sp.max ?? 0);
        sp.baseMax = baseMax;
        sp.max = Math.max(0, baseMax + (sp.bonus ?? 0));
        sp.value = Math.clamp(sp.value ?? 0, 0, sp.max);

        // Маназависимость: действует только пока есть недостаток
        const addiction = this.spheres.addiction;
        const baseProf = this.attributes.prof || 0;
        const active = hasAddictiveCastingDrawback(this.parent);

        addiction.active = active;
        addiction.maxLevel = active ? baseProf : 0;
        addiction.level = active ? Math.clamp(addiction.level || 0, 0, baseProf) : 0;

        // ВНИМАНИЕ: это выполняется после super.prepareDerivedData(), поэтому навыки/спасброски,
        // посчитанные внутри dnd5e, могут не увидеть сниженный БМ. Проверь на листе (см. сообщение).
        if (active && addiction.level > 0) {
            this.attributes.prof = Math.max(0, baseProf - addiction.level);
        }
    }

    getRollData(options) {
        const data = super.getRollData(options);
        data.spheres = {
            casterLevel: this.spheres.casterLevel,
            spellPoints: { ...this.spheres.spellPoints },
            addiction: { ...this.spheres.addiction }
        };
        return data;
    }
}

/* -------------------------------------------- */
/*  Character sheet                             */
/* -------------------------------------------- */

class SpheresCharacterSheet extends dnd5e.applications.actor.CharacterActorSheet {

    static PARTS = {
        ...super.PARTS,
        spheres: {
            template: `${TEMPLATE_DIR}/spheres-tab.hbs`,
            scrollable: [".items-list"]
        }
    };

    static TABS = [
        ...super.TABS,
        { tab: "spheres", group: "primary", label: "SOP.TabSpheres", icon: "fas fa-circle-nodes" }
    ];

    /** @inheritDoc */
    async _preparePartContext(partId, context, options) {
        context = await super._preparePartContext(partId, context, options);

        switch (partId) {
            case "spheres":
                return this._prepareSpheresContext(context, options);
            case "features":
                return this._prepareFeaturesFilteredContext(context, options);
            default:
                return context;
        }
    }

    /** @inheritDoc */
    _onRender(context, options) {
        super._onRender(context, options);

        // Переносим часть «spheres» внутрь .tab-body, рядом с остальными вкладками
        const tabBody = this.element.querySelector(".tab-body");
        const spheresPart = this.element.querySelector('[data-application-part="spheres"]');
        if (tabBody && spheresPart && spheresPart.parentElement !== tabBody) {
            tabBody.appendChild(spheresPart);
        }
    }

    async _prepareSpheresContext(context, options) {
        const actor = this.document;

        context.elements = this.options.elements;
        context.tab = context.tabs?.spheres ?? { cssClass: "" };

        const spheres = actor.system.spheres;
        const spValue = spheres?.spellPoints?.value ?? 0;
        const spMax = spheres?.spellPoints?.max ?? 0;
        const spPercentage = spMax > 0 ? Math.round((spValue / spMax) * 100) : 0;

        context.spellPointsData = {
            value: spValue,
            max: spMax,
            percentage: Math.clamp(spPercentage, 0, 100),
            casterLevel: spheres?.casterLevel ?? 0,
            editable: this.isEditable
        };

        const Inventory = customElements.get(this.options.elements.inventory);
        const columns = Inventory
            ? Inventory.mapColumns([{ id: "uses", order: 200 }, "recovery", "controls"])
            : [];

        const sphereSubtypes = ["tradition", "sphere", "talent", "drawback", "boon"];
        const rawSections = sphereSubtypes.map((subtype, idx) => ({
            columns,
            id: subtype,
            label: CONFIG.DND5E.featureTypes.sphere?.subtypes?.[subtype] ?? subtype.capitalize(),
            order: (idx + 1) * 100,
            groups: {},
            items: [],
            dataset: { type: "feat", "system.type.value": "sphere", "system.type.subtype": subtype }
        }));

        for (const item of actor.items) {
            const sys = item.system;
            if (item.type === "feat" && sys?.type?.value === "sphere") {
                const subtype = sys.type.subtype || "talent";
                const section = rawSections.find(s => s.id === subtype);
                if (section) section.items.push(item);
            }
        }

        const activeSections = rawSections.filter(s => s.items.length > 0 || s.id === "talent");
        context.sphereSections = Inventory ? Inventory.prepareSections(activeSections) : activeSections;

        context.spheresListControls = {
            label: "DND5E.FeatureSearch",
            list: "spheres",
            filters: []
        };

        return context;
    }

    /** Убирает особенности Сфер из обычной вкладки «Особенности». */
    async _prepareFeaturesFilteredContext(context, options) {
        const sectionsList = context.sections ?? context.features;

        if (Array.isArray(sectionsList)) {
            for (const section of sectionsList) {
                if (!Array.isArray(section.items)) continue;
                section.items = section.items.filter(item => {
                    const doc = item.document ?? item;
                    return !(doc.type === "feat" && doc.system?.type?.value === "sphere");
                });
            }
        }

        return context;
    }
}

/* -------------------------------------------- */
/*  Sidebar: spell points meter                 */
/* -------------------------------------------- */

function activateSpellPointMeter(sheet, root) {
    if (!root) return;

    const meter = root.querySelector(".progress.spell-points[role='meter']");
    const label = meter?.querySelector(":scope > .label");
    const input = meter?.querySelector(":scope > input");
    if (!meter || !label || !input) return;

    let cancelled = false;

    const close = () => {
        label.hidden = false;
        input.hidden = true;
    };

    meter.addEventListener("click", event => {
        if (!sheet.isEditable || event.target === input) return;
        label.hidden = true;
        input.hidden = false;
        input.focus();
        input.select();
    });

    input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            input.blur();
        } else if (event.key === "Escape") {
            cancelled = true;
            input.blur();
        }
    });

    input.addEventListener("blur", async () => {
        const current = sheet.actor.system.spheres.spellPoints;
        close();

        if (cancelled) {
            cancelled = false;
            input.value = current.value;
            return;
        }

        let value = Number(input.value);
        if (!Number.isFinite(value)) value = 0;
        value = Math.clamp(Math.trunc(value), 0, current.max ?? 0);

        if (value !== current.value) {
            await sheet.actor.update({ "system.spheres.spellPoints.value": value });
        }
    });
}

/** Включён ли режим редактирования листа (а не просто доступно редактирование). */
function isEditMode(sheet) {
    if (!sheet.isEditable) return false;
    const modes = sheet.constructor.MODES;
    if (modes && "_mode" in sheet) return sheet._mode === modes.EDIT;
    return true; // если dnd5e изменит внутреннее API, шестерёнка просто будет видна всегда
}

/** Диалог: базовый максимум и ситуативный бонус к очкам заклинаний. */
async function openSpellPointsConfig(actor) {
    const L = key => game.i18n.localize(key);
    const source = actor._source.system.spheres.spellPoints;

    const content = `
        <div class="form-group">
            <label>${L("SOP.SpellPointsBaseMax")}</label>
            <div class="form-fields">
                <input type="number" name="max" value="${source.max ?? 0}" min="0" step="1" autofocus>
            </div>
        </div>
        <div class="form-group">
            <label>${L("SOP.SpellPointsBonus")}</label>
            <div class="form-fields">
                <input type="number" name="bonus" value="${source.bonus ?? 0}" step="1">
            </div>
            <p class="hint">${L("SOP.SpellPointsBonusHint")}</p>
        </div>`;

    const num = el => (Number.isFinite(el.valueAsNumber) ? Math.trunc(el.valueAsNumber) : 0);

    const result = await foundry.applications.api.DialogV2.prompt({
        window: { title: `${L("SOP.SpellPointsConfigure")}: ${actor.name}`, icon: "fa-solid fa-gear" },
        content,
        ok: {
            label: L("SOP.Dialog.Save"),
            icon: "fa-solid fa-check",
            callback: (event, button) => ({
                max: Math.max(0, num(button.form.elements.max)),
                bonus: num(button.form.elements.bonus)
            })
        },
        rejectClose: false
    });
    if (!result) return;

    await actor.update({
        "system.spheres.spellPoints.max": result.max,
        "system.spheres.spellPoints.bonus": result.bonus
    });
}

function activateSpellPointConfig(sheet, root) {
    root?.querySelector(".sop-sp-config")?.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        openSpellPointsConfig(sheet.actor);
    });
}

/**
 * Хук рендера листа. Сначала асинхронно готовим HTML, и только потом
 * синхронно удаляем старые копии и вставляем новые — так дублей не бывает.
 */
async function injectSidebarWidgets(sheet, html) {
    const element = html instanceof HTMLElement
        ? html
        : (html?.[0] instanceof HTMLElement ? html[0] : null);
    if (!element) return;

    const spheres = sheet.actor?.system?.spheres;
    if (!spheres) return;

    const max = spheres.spellPoints?.max ?? 0;
    const value = spheres.spellPoints?.value ?? 0;
    const editMode = isEditMode(sheet);

    // В режиме редактирования метр виден всегда — иначе при max = 0 до шестерёнки не добраться
    let content = null;
    if (max > 0 || editMode) {
        content = await foundry.applications.handlebars.renderTemplate(
            `${TEMPLATE_DIR}/spell-points-meter.hbs`,
            {
                value,
                max,
                percentage: max > 0 ? Math.clamp(Math.round((value / max) * 100), 0, 100) : 0,
                editable: sheet.isEditable,
                configurable: editMode
            }
        );
    }

    // --- дальше всё синхронно ---
    element.querySelectorAll(".custom-spell-points").forEach(n => n.remove());

    if (content) {
        const firstGroup = element.querySelector(".meter-group");
        if (firstGroup) firstGroup.insertAdjacentHTML("afterend", content);
        else element.insertAdjacentHTML("beforeend", content);

        const inserted = element.querySelector(".custom-spell-points");
        activateSpellPointMeter(sheet, inserted);
        activateSpellPointConfig(sheet, inserted);
    }

    // Зависимость не зависит от наличия очков заклинаний
    injectAddictionPips(sheet, element);
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
    CONFIG.Actor.dataModels.character = SpheresCharacterData;

    CONFIG.DND5E.spellcasting.sphere = {
        label: "SOP.progression.label",
        type: "multi",
        order: 20,
        progression: {
            sphereFull: { label: "SOP.progression.Full.label", divisor: 1 },
            sphereHalf: { label: "SOP.progression.Half.label", divisor: 2, roundUp: true },
            sphereThird: { label: "SOP.progression.Third.label", divisor: 3 }
        }
    };

    CONFIG.DND5E.featureTypes.sphere = {
        label: "SOP.FeatureType",
        subtypes: {
            tradition: "SOP.SubtypeTradition",
            sphere: "SOP.SubtypeSphere",
            talent: "SOP.SubtypeTalent",
            drawback: "SOP.SubtypeDrawback",
            boon: "SOP.SubtypeBoon"
        }
    };

    foundry.applications.apps.DocumentSheetConfig.registerSheet(
        Actor,
        "dnd5e",
        SpheresCharacterSheet,
        {
            types: ["character"],
            label: "Spheres Character Sheet"
        }
    );
});

Hooks.once("i18nInit", () => {
    const sphereConfig = CONFIG.DND5E.featureTypes.sphere;
    if (sphereConfig) {
        sphereConfig.label = game.i18n.localize(sphereConfig.label);
        for (const [key, value] of Object.entries(sphereConfig.subtypes)) {
            sphereConfig.subtypes[key] = game.i18n.localize(value);
        }
    }

    // Локализация — повторный вызов на уже переведённой строке безвреден
    const casting = CONFIG.DND5E.spellcasting.sphere;
    if (casting) {
        casting.label = game.i18n.localize(casting.label);
        for (const prog of Object.values(casting.progression)) {
            prog.label = game.i18n.localize(prog.label);
        }
    }
});

/**
 * Ресурсы токена. CONFIG.DND5E.trackableAttributes — не тот объект;
 * список для токенов лежит в CONFIG.Actor.trackableAttributes.
 * Если dnd5e его не задаёт, ядро Foundry само берёт поля из схемы.
 */
Hooks.once("setup", () => {
    const tracked = CONFIG.Actor.trackableAttributes;
    if (!tracked) return;

    if (Array.isArray(tracked.bar) && !tracked.bar.includes("spheres.spellPoints")) {
        tracked.bar.push("spheres.spellPoints");
    }
    if (Array.isArray(tracked.value) && !tracked.value.includes("spheres.casterLevel")) {
        tracked.value.push("spheres.casterLevel");
    }
});

Hooks.on("renderCharacterActorSheet", injectSidebarWidgets);
