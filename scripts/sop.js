const MODULE_ID = "spheres-of-power";
const { SchemaField, NumberField, StringField } = foundry.data.fields;

/** Путь к очкам заклинаний для расхода в действиях (consumption target «attribute»). */
const SPELL_POINTS_PATH = "spheres.spellPoints.value";

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
            // Ключевая характеристика традиции; пусто — берётся заклинательная характеристика dnd5e
            ability: new StringField({ initial: "", blank: true }),
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
        this._applyAddictionPenalty();
    }

    /**
     * Манозависимость снижает бонус мастерства. dnd5e задаёт БМ в prepareBaseData,
     * а спасброски, навыки, СЛ и атаки считает уже в prepareDerivedData — поэтому
     * штраф применяется здесь, до них, и все они видят сниженное значение.
     */
    _applyAddictionPenalty() {
        const addiction = this.spheres.addiction;
        const baseProf = this.attributes.prof || 0;
        const active = hasAddictiveCastingDrawback(this.parent);

        addiction.active = active;
        addiction.baseProf = baseProf;
        addiction.maxLevel = active ? baseProf : 0;
        addiction.level = active ? Math.clamp(addiction.level || 0, 0, baseProf) : 0;

        if (addiction.level > 0) this.attributes.prof = Math.max(0, baseProf - addiction.level);
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

        // Ключевая характеристика: СЛ сферы = 8 + БМ + мод., атака сферы = БМ + мод. (книга, стр. 5).
        // БМ уже учитывает штраф манозависимости.
        const prof = this.attributes.prof || 0;
        const key = this.spheres.ability || this.attributes.spellcasting || "";
        const mod = this.abilities[key]?.mod ?? 0;
        this.spheres.keyAbility = key;
        this.spheres.mod = mod;
        this.spheres.attack = prof + mod;
        this.spheres.dc = 8 + prof + mod;
        // Больше этого нельзя потратить на один эффект вместе с подпитками
        sp.maxSpend = prof;
    }

    getRollData(options) {
        const data = super.getRollData(options);
        data.spheres = {
            casterLevel: this.spheres.casterLevel,
            mod: this.spheres.mod ?? 0,
            attack: this.spheres.attack ?? 0,
            dc: this.spheres.dc ?? 8,
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
            keyAbility: CONFIG.DND5E.abilities[spheres?.keyAbility]?.label ?? "—",
            dc: spheres?.dc ?? 8,
            attack: (spheres?.attack ?? 0) >= 0 ? `+${spheres?.attack ?? 0}` : `${spheres.attack}`,
            maxSpend: spheres?.spellPoints?.maxSpend ?? 0,
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
    const ability = actor._source.system.spheres.ability ?? "";
    const fallback = CONFIG.DND5E.abilities[actor.system.attributes.spellcasting]?.label;
    const options = [
        `<option value="">${L("SOP.KeyAbilityDefault")}${fallback ? ` (${fallback})` : ""}</option>`,
        ...Object.entries(CONFIG.DND5E.abilities).map(([id, cfg]) =>
            `<option value="${id}" ${id === ability ? "selected" : ""}>${cfg.label}</option>`)
    ].join("");

    const content = `
        <div class="form-group">
            <label>${L("SOP.KeyAbility")}</label>
            <div class="form-fields">
                <select name="ability">${options}</select>
            </div>
            <p class="hint">${L("SOP.KeyAbilityHint")}</p>
        </div>
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
                ability: button.form.elements.ability.value,
                max: Math.max(0, num(button.form.elements.max)),
                bonus: num(button.form.elements.bonus)
            })
        },
        rejectClose: false
    });
    if (!result) return;

    await actor.update({
        "system.spheres.ability": result.ability,
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

/** Очки заклинаний можно указывать как расходуемый ресурс в действиях. dnd5e заполняет список в своём setup. */
Hooks.once("setup", () => {
    const resources = CONFIG.DND5E.consumableResources;
    if (Array.isArray(resources) && !resources.includes(SPELL_POINTS_PATH)) resources.push(SPELL_POINTS_PATH);
});

/** Запас очков заклинаний полностью восстанавливается после продолжительного отдыха (книга, стр. 5). */
Hooks.on("dnd5e.preRestCompleted", (actor, result) => {
    const sp = actor.system.spheres?.spellPoints;
    if (!result.longRest || !sp || (sp.value >= sp.max)) return;
    result.updateData["system.spheres.spellPoints.value"] = sp.max;
});

/**
 * На один эффект сферы (вместе с подпитками) нельзя потратить больше очков, чем бонус мастерства
 * (книга, стр. 5). Считаем очки, которые списывает это действие.
 */
Hooks.on("dnd5e.preActivityConsumption", (activity, usageConfig) => {
    const sp = activity.actor?.system.spheres?.spellPoints;
    if (!sp || (usageConfig.consume?.resources === false)) return;

    const cost = activity.consumption.targets
        .filter(t => (t.type === "attribute") && (t.target === SPELL_POINTS_PATH))
        .reduce((sum, t) => sum + (Number(t.value) || 0), 0);
    if (cost <= sp.maxSpend) return;

    ui.notifications.warn(game.i18n.format("SOP.Warning.MaxSpend", { cost, max: sp.maxSpend }));
    return false;
});

Hooks.on("renderCharacterActorSheet", injectSidebarWidgets);
