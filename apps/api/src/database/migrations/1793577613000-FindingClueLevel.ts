import type { MigrationInterface, QueryRunner } from 'typeorm';
export class FindingClueLevel1793577613000 implements MigrationInterface {
  name = 'FindingClueLevel1793577613000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query("ALTER TABLE findings ADD COLUMN clueLevel varchar(16) NOT NULL DEFAULT 'actionable'");
    await runner.query("UPDATE findings SET clueLevel = 'weakness' WHERE id IN (SELECT id FROM facts WHERE predicate IN ('missing_security_headers','directory_listing_enabled','version_disclosure'))");
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = await runner.query("SELECT COUNT(*) AS n FROM findings WHERE clueLevel = 'weakness'");
    if (Number(rows[0].n)) throw new Error('弱点分类非空，拒绝丢失分层数据');
    await runner.query('ALTER TABLE findings DROP COLUMN clueLevel');
  }
}
