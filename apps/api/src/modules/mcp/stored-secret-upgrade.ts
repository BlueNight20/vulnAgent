import type { EntityManager } from 'typeorm';
import type { AppConfig } from '../../config/configuration';
import { AuditLogEntity, McpServerEntity, SystemSettingEntity } from '../../database/entities';
import { serialTransaction } from '../../database/serial-transaction';
import { configuredCipher, readStoredHeaders, validateHeaders } from '../../common/crypto/mcp-header-secrets';
import { newId } from '../../common/utils/id';

/** Master-key dependent data upgrade, separate from the schema migration/CLI. */
export async function upgradeStoredSecrets(manager: EntityManager, security?: AppConfig['security']): Promise<void> {
  await serialTransaction(manager, async (tx) => {
    const model = await tx.findOne(SystemSettingEntity, { where: { key: 'model.apiKey' } });
    const servers = await tx.find(McpServerEntity);
    const cipher = configuredCipher(security);
    // Validate existing ciphertext first: a lost key must never be replaced while encrypting legacy data.
    if (model?.encrypted) {
      try { cipher.decrypt(model.value); }
      catch { throw new Error('已有模型密钥无法解密；请恢复原加密主密钥，配置升级未提交'); }
    }
    for (const server of servers) if (server.headersEncrypted != null) readStoredHeaders(server, security);
    let modelCount = 0; let headerCount = 0;
    if (model && !model.encrypted && model.value) {
      await tx.update(SystemSettingEntity, { key: model.key }, { value: cipher.encrypt(model.value), encrypted: true }); modelCount++;
    }
    for (const server of servers) {
      if (server.headersEncrypted != null || server.headers == null) continue;
      const headers = validateHeaders(server.headers);
      await tx.update(McpServerEntity, { id: server.id }, { headers: null, headersEncrypted: headers && Object.keys(headers).length ? cipher.encrypt(JSON.stringify(headers)) : null }); headerCount++;
    }
    if (modelCount || headerCount) await tx.insert(AuditLogEntity, {
      id: newId(), actor: 'system', action: 'security.secrets_upgraded', entityType: 'system_settings',
      detail: { modelCount, headerCount }, result: 'success', taskId: null, entityId: null,
    });
  });
}
