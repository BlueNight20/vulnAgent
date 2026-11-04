import type { DeepPartial, EntityManager, ObjectLiteral, Repository } from 'typeorm';
import { AsyncLocalStorage } from 'node:async_hooks';

const queues = new WeakMap<object, Promise<unknown>>();
const transactionContext = new AsyncLocalStorage<{ connection: object; manager: EntityManager }>();
/** 同一 SQLite 数据源的异步写事务依次提交，避免共享连接上交错回滚。 */
export async function serialTransaction<T>(manager: EntityManager, action: (transaction: EntityManager) => Promise<T>): Promise<T> {
  const key = manager.connection;
  const current = transactionContext.getStore();
  if (current?.connection === key && current.manager.queryRunner?.isTransactionActive) return action(current.manager);
  const previous = queues.get(key) ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(() => manager.transaction((transaction) => transactionContext.run({ connection: key, manager: transaction }, () => action(transaction))));
  queues.set(key, work);
  try { return await work; }
  finally { if (queues.get(key) === work) queues.delete(key); }
}

export function serialSave<T extends ObjectLiteral>(repo: Repository<T>, value: DeepPartial<T>): Promise<T>;
export function serialSave<T extends ObjectLiteral>(repo: Repository<T>, value: DeepPartial<T>[]): Promise<T[]>;
export function serialSave<T extends ObjectLiteral>(repo: Repository<T>, value: DeepPartial<T> | DeepPartial<T>[]): Promise<T | T[]> {
  return serialTransaction(repo.manager, (manager) => manager.getRepository<T>(repo.target).save(value as DeepPartial<T>));
}
export function serialUpdate<T extends ObjectLiteral>(repo: Repository<T>, ...args: Parameters<Repository<T>['update']>) {
  return serialTransaction(repo.manager, (manager) => manager.getRepository<T>(repo.target).update(...args));
}
export function serialInsert<T extends ObjectLiteral>(repo: Repository<T>, ...args: Parameters<Repository<T>['insert']>) {
  return serialTransaction(repo.manager, (manager) => manager.getRepository<T>(repo.target).insert(...args));
}
export function serialDelete<T extends ObjectLiteral>(repo: Repository<T>, ...args: Parameters<Repository<T>['delete']>) {
  return serialTransaction(repo.manager, (manager) => manager.getRepository<T>(repo.target).delete(...args));
}
export function serialRemove<T extends ObjectLiteral>(repo: Repository<T>, value: T): Promise<T>;
export function serialRemove<T extends ObjectLiteral>(repo: Repository<T>, value: T[]): Promise<T[]>;
export function serialRemove<T extends ObjectLiteral>(repo: Repository<T>, value: T | T[]) {
  return serialTransaction(repo.manager, (manager) => manager.getRepository<T>(repo.target).remove(value as T));
}
