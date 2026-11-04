import type { MigrationInterface, QueryRunner } from 'typeorm';

export class TaskGoal1793577602000 implements MigrationInterface {
  name = 'TaskGoal1793577602000';
  async up(runner: QueryRunner): Promise<void> {
    const column = (await runner.getTable('tasks'))?.columns.find((c) => c.name === 'goal');
    if (!column) await runner.query('ALTER TABLE "tasks" ADD COLUMN "goal" text');
    else if (column.type !== 'text' || !column.isNullable) throw new Error('任务目标字段与迁移定义不一致');
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = await runner.query('SELECT COUNT(*) AS n FROM tasks WHERE goal IS NOT NULL');
    if (rows[0].n) throw new Error('已存在任务目标，拒绝删除；请使用备份恢复');
    await runner.query('ALTER TABLE "tasks" DROP COLUMN "goal"');
  }
}
