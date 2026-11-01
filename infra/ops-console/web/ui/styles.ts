/**
 * Единая карта классов примитивов: страницы пишут `ui.table`, `ui.formGrid`, `ui.panel` —
 * не важно, в каком из CSS-модулей класс объявлен. Имена классов в модулях не пересекаются.
 */
import base from './ui.module.css'
import controls from './controls.module.css'
import table from './table.module.css'

const styles: Readonly<Record<string, string>> = { ...base, ...table, ...controls }

export default styles
