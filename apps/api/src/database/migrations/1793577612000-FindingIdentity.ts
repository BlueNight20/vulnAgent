import type { MigrationInterface, QueryRunner } from 'typeorm';
export class FindingIdentity1793577612000 implements MigrationInterface {
  name = 'FindingIdentity1793577612000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE findings ADD COLUMN canonicalKey varchar(64) NULL');
    await runner.query("ALTER TABLE findings ADD COLUMN sourceFactIds text NOT NULL DEFAULT '[]'");
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = await runner.query("SELECT COUNT(*) AS n FROM findings WHERE canonicalKey IS NOT NULL OR sourceFactIds != '[]'");
    if (Number(rows[0].n)) throw new Error('漏洞来源关联非空，拒绝丢失合并历史');
    await runner.query('ALTER TABLE findings DROP COLUMN sourceFactIds');
    await runner.query('ALTER TABLE findings DROP COLUMN canonicalKey');
  }
}
