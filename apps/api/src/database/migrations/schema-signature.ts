import type { Table } from 'typeorm';

/** 比较已落库结构，不依赖未来可能变化的实体元数据。 */
export function schemaSignature(table: Table): string {
  const byName = <T extends { name: string }>(rows: T[]) => rows.sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({
    columns: byName(table.columns.map((c) => ({
      name: c.name, type: c.type, length: c.length || '', nullable: c.isNullable,
      primary: c.isPrimary, generated: c.isGenerated, unique: c.isUnique,
      default: c.default === undefined ? null : String(c.default),
    }))),
    indices: byName(table.indices.map((i) => ({ name: i.name!, columns: i.columnNames, unique: i.isUnique, where: i.where || '' }))),
    uniques: byName(table.uniques.map((u) => ({ name: u.name!, columns: u.columnNames }))),
    foreignKeys: byName(table.foreignKeys.map((f) => ({ name: f.name!, columns: f.columnNames,
      table: f.referencedTableName, referenced: f.referencedColumnNames, onDelete: f.onDelete, onUpdate: f.onUpdate }))),
  });
}
