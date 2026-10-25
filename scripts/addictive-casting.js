const MODULE_ID = "spheres-of-power";
const DC_MIN = 8;
const DC_MAX = 30;

/** Имена, по которым черта распознаётся, если нет флага/идентификатора. */
const DRAWBACK_NAMES = [
    "магическая зависимость",
    "манозависимость",
    "маназависимость",
    "addictive casting"
];

/**
 * Есть ли у актёра недостаток «Магическая зависимость».
 * Используется и дата-моделью (штраф к БМ), и интерфейсом (пипсы),
 * поэтому штраф исчезает вместе с недостатком.
 *
 * Надёжнее всего пометить предмет в компендиуме одним из способов:
 *  - system.identifier = "addictive-casting"
 *  - флаг flags.spheres-of-power.addictiveCasting = true
 * Проверка по имени оставлена как запасной вариант.
 */
export function hasAddictiveCastingDrawback(actor) {
    return actor.items.some(item => {
        if (item.type !== "feat") return false;

        const type = item.system?.type;
        if (type?.value !== "sphere" || type?.subtype !== "drawback") return false;

        if (item.flags?.[MODULE_ID]?.addictiveCasting) return true;
        if (item.system?.identifier === "addictive-casting") return true;

        const name = item.name.toLowerCase();
        return DRAWBACK_NAMES.some(n => name.includes(n));
    });
}

/**
 * Вставляет (или обновляет) виджет зависимости в боковую панель.
 * Функция синхронная: старая копия удаляется и новая вставляется в один тик,
 * поэтому дублей быть не может, а значения всегда свежие.
 */
export function injectAddictionPips(sheet, element) {
    element.querySelectorAll(".custom-addiction-meter").forEach(n => n.remove());

    const actor = sheet.actor;
    if (!hasAddictiveCastingDrawback(actor)) return;

    const addiction = actor.system.spheres.addiction;
    const level = addiction.level;
    const maxLevel = addiction.maxLevel;
    const dc = addiction.dc;
    const editable = sheet.isEditable;
    const L = key => game.i18n.localize(key);

    const pips = Array.from({ length: maxLevel }, (_, i) => {
        const n = i + 1;
        const state = n <= level ? "filled" : "empty";
        const tooltip = `${L("SOP.Addiction.Penalty")}: -${n}`;
        return `<button type="button" class="pip ${state}" data-n="${n}"
                    data-tooltip="${tooltip}" aria-label="${tooltip}"></button>`;
    }).join("");

    const dcControls = editable ? `
        <span class="dc-controls">
            <button type="button" class="dc-btn" data-dc-step="1"
                data-tooltip="${L("SOP.Addiction.Fail")}" aria-label="${L("SOP.Addiction.Fail")}">+1</button>
            <button type="button" class="dc-btn" data-dc-step="-2"
                data-tooltip="${L("SOP.Addiction.Success")}" aria-label="${L("SOP.Addiction.Success")}">−2</button>
        </span>` : "";

    const html = `
        <div class="meter-group custom-addiction-meter">
            <div class="label roboto-condensed-upper">
                <span>${L("SOP.Addiction.Label")} (${L("SOP.Addiction.DC")} ${dc})</span>
                ${dcControls}
            </div>
            <div class="pips">${pips}</div>
        </div>`;

    const anchor = element.querySelector(".custom-spell-points")
        ?? element.querySelector(".meter-group");
    if (anchor) anchor.insertAdjacentHTML("afterend", html);
    else element.insertAdjacentHTML("beforeend", html);

    activateAddictionPips(sheet, element.querySelector(".custom-addiction-meter"));
}

/** Клики по пипсам и кнопкам СЛ. */
export function activateAddictionPips(sheet, root) {
    if (!root || !sheet.isEditable) return;

    root.addEventListener("click", async event => {
        const addiction = sheet.actor.system.spheres.addiction;

        const pip = event.target.closest(".pip");
        if (pip) {
            const clicked = Number(pip.dataset.n);
            // Повторный клик по текущему уровню снимает одну точку
            const newLevel = clicked === addiction.level ? clicked - 1 : clicked;
            await sheet.actor.update({ "system.spheres.addiction.level": Math.max(0, newLevel) });
            return;
        }

        const btn = event.target.closest(".dc-btn");
        if (btn) {
            const step = Number(btn.dataset.dcStep);
            const newDC = Math.clamp((addiction.dc || DC_MIN) + step, DC_MIN, DC_MAX);
            await sheet.actor.update({ "system.spheres.addiction.dc": newDC });
        }
    });
}
