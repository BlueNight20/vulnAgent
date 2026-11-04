import Ajv, { type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';

// MCP 工具可能使用不同 JSON Schema 版本。只校验，不转换参数或注入默认值。
const options = { allErrors: true, strict: false, validateFormats: false, addUsedSchema: false };
const validators = { draft7: new Ajv(options), draft2019: new Ajv2019(options), draft2020: new Ajv2020(options) };
const compiled = new Map<string, ValidateFunction>();

export function validateToolInput(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  try {
    const key = JSON.stringify(schema);
    let validate = compiled.get(key);
    if (!validate) {
      const dialect = String(schema.$schema ?? '');
      const ajv = dialect.includes('2020-12') ? validators.draft2020
        : dialect.includes('2019-09') ? validators.draft2019 : validators.draft7;
      validate = ajv.compile(schema);
      if (compiled.size >= 128) compiled.delete(compiled.keys().next().value!);
      compiled.set(key, validate);
    }
    if (validate(args)) return null;
    const errors = (validate.errors ?? []).slice(0, 8).map((error) => {
      const field = error.keyword === 'required' ? `/${String(error.params.missingProperty)}` : error.instancePath || '/';
      return `${field}: ${error.message}`;
    });
    return `工具参数不符合 inputSchema：${errors.join('；')}。请修正参数后重新调用。`;
  } catch {
    return '工具 inputSchema 无效或使用了不支持的引用，请重新同步工具目录或修复服务端声明。';
  }
}
