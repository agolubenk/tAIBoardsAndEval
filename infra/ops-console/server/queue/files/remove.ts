/** Удаление вложений пункта: строки, затем файлы с диска. Без настроенного каталога — только строки. */
import { getEnv } from '../../env'
import { finalPath, removeQuiet } from './storage'
import { deleteItemFileRows } from './store'

export async function removeItemFiles(itemId: string): Promise<void> {
  const ids = await deleteItemFileRows(itemId)
  const dir = getEnv().oqFiles.dir
  if (!dir) return
  await Promise.all(ids.map((id) => removeQuiet(finalPath(dir, id))))
}
