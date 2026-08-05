const MODULE_ID = "spheres-of-power";

class SpheresCasterProgression {
    static compute(actor) {
        let casterLevel = 0;
        for (const cls of actor.items.filter(i => i.type === "class")) {
            const progression = cls.getFlag(MODULE_ID, "sphereProgression");
            if (!progression) continue;
            switch (progression) {
                case "full": casterLevel += cls.system.levels; break;
                case "half": casterLevel += Math.floor(cls.system.levels / 2); break;
                case "third": casterLevel += Math.floor(cls.system.levels / 3); break;
            }
        }
        return casterLevel;
    }
}

class SpheresCharacterSheet extends dnd5e.applications.actor.CharacterActorSheet {
    static PARTS = {
        ...super.PARTS,
        spheres: {
            container: { classes: ["tab-body"], id: "tabs" },
            template: "modules/spheres-of-power/templates/actor/spheres-tab.hbs",
            scrollable: [""]
        }
    };

    static TABS = [
        ...super.TABS,
        { tab: "spheres", label: "Spheres", icon: "fas fa-circle-nodes" }
    ];

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        
        context.spheres = this.actor.system.spells.spheres || {
            casterLevel: 0,
            spellPoints: { value: 0, max: 0 }
        };

        return context;
    }
}

Hooks.once("init", () => {
    
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

    CONFIG.DND5E.trackableAttributes.spellPoints = {
        label: "Spell Points",
        path: "actor.system.spells.spheres.spellPoints.value"
    }

    const originalPrepareBaseData = dnd5e.documents.Actor5e.prototype.prepareBaseData;
    dnd5e.documents.Actor5e.prototype.prepareBaseData = function (...args) {
        originalPrepareBaseData.apply(this, args);
        if (this.type === "character") {
            const casterLevel = SpheresCasterProgression.compute(this);
            this.system.spells.spheres ??= {};
            this.system.spells.spheres.casterLevel = casterLevel;
                        this.system.spells.spheres.spellPoints = {
                max: 0,
                value: 0
            };
        }
    };

    const originalPrepareDerivedData = dnd5e.documents.Actor5e.prototype.prepareDerivedData;
    dnd5e.documents.Actor5e.prototype.prepareDerivedData = function (...args) {
        originalPrepareDerivedData.apply(this, args);
        
        if (this.type === "character" && this.system.spells.spheres) {
            const spellPointsMax = this.system.spells.spheres.spellPoints.max;
            let spellPointsValue = this.getFlag(MODULE_ID, "spellPointsValue");
            if (spellPointsValue === undefined || spellPointsValue === null) {
                spellPointsValue = spellPointsMax;
            }            
            this.system.spells.spheres.spellPoints.value = Math.max(0, Math.min(spellPointsValue, spellPointsMax));
        }
    };

    const modelsToPatch = ["CharacterData", "NPCData"];
    for (const modelName of modelsToPatch) {
        if (!dnd5e.dataModels.actor[modelName]) continue;
        
        const originalModelGetRollData = dnd5e.dataModels.actor[modelName].prototype.getRollData;
        
        dnd5e.dataModels.actor[modelName].prototype.getRollData = function(options) {
            const data = originalModelGetRollData.call(this, options);
            
            if (this.parent && this.parent.system.spells.spheres) {
                data.spells.spheres = foundry.utils.deepClone(this.parent.system.spells.spheres);
            }
            
            return data;
        };
    }

    foundry.applications.apps.DocumentSheetConfig.registerSheet(
        Actor,
        "dnd5e",
        SpheresCharacterSheet,
        {
            types: ["character"],
            makeDefault: false,
            label: "Spheres Character Sheet"
        }
    );
});

Hooks.on("renderCharacterActorSheet", async (sheet, html, data) => {
    const $html = $(html);
    const actor = sheet.document || sheet.actor;
    
    // Если у актера нет сфер, ничего не делаем
    if (!actor?.system?.spheres) return;

    const isEditable = data.editable ?? sheet.isEditable !== false;

    // 1. Рендерим наш .hbs шаблон асинхронно
    const templatePath = "modules/spheres-of-power/templates/actor/spell-points-meter.hbs";
    const spHtml = await renderTemplate(templatePath, {
        system: actor.system,
        editable: isEditable
    });

    // 2. Ищем место для вставки в сайдбаре (сразу после Hit Dice)
    const statsContainer = $html.find('.sidebar .stats, .main-content .stats').first();
    const hitDiceBlock = statsContainer.find('.meter.hit-dice').closest('.meter-group');

    if (hitDiceBlock.length) {
        hitDiceBlock.after(spHtml);
    } else {
        statsContainer.append(spHtml);
    }

    // 3. Добавляем интерактивность клика по тексту для открытия поля ввода
    if (isEditable) {
        const injectedBlock = $html.find('.custom-spell-points');
        const textLabel = injectedBlock.find('.sp-text');
        const inputField = injectedBlock.find('.sp-input');

        // Клик по цифрам — скрываем текст, показываем числовое поле
        textLabel.on('click', () => {
            textLabel.hide();
            inputField.show().trigger('focus').select();
        });

        // Функция сохранения при потере фокуса или нажатии Enter
        const saveValue = async () => {
            let newVal = parseInt(inputField.val());
            const max = actor.system.spells.spheres.spellPoints.max || 0;
            if (isNaN(newVal)) newVal = actor.system.spells.spheres.spellPoints.value;
            
            // Ограничиваем значение в пределах от 0 до max
            newVal = Math.max(0, Math.min(newVal, max));

            await actor.setFlag("spheres-of-power", "spellPointsValue", newVal);
            
            inputField.hide();
            textLabel.show();
        };

        inputField.on('blur', saveValue);
        inputField.on('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                inputField.trigger('blur');
            }
        });
    }
});