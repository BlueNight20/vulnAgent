"""Authoring helper: wrap only fields explicitly typed Repository<T>, never Maps or services."""
from pathlib import Path
import os
import re

base = Path(__file__).resolve().parent.parent
helper = base / 'apps/api/src/database/serial-transaction'
changed = []
for path in (base / 'apps/api/src/modules').rglob('*.ts'):
    if path.name.endswith('.spec.ts'):
        continue
    content = path.read_text(encoding='utf-8')
    fields = set(re.findall(r'\b(\w+)\s*:\s*Repository<', content))
    methods = set()
    for field in fields:
        for method in ('save', 'update', 'insert', 'delete', 'remove'):
            pattern = rf'\bthis\.{re.escape(field)}\.{method}\('
            if re.search(pattern, content):
                wrapper = 'serial' + method.capitalize()
                content = re.sub(pattern, f'{wrapper}(this.{field}, ', content)
                methods.add(wrapper)
    if not methods:
        continue
    relative = os.path.relpath(helper, path.parent).replace('\\', '/')
    if not relative.startswith('.'):
        relative = './' + relative
    content = f"import {{ {', '.join(sorted(methods))} }} from '{relative}';\n" + content
    path.write_text(content, encoding='utf-8', newline='')
    changed.append(str(path.relative_to(base)))
print('Serialized repository writes in', len(changed), 'service files')
print('\n'.join(changed))
