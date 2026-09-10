import json


def strict_schema(schema):
    schema = json.loads(json.dumps(schema))
    def walk(node):
        if isinstance(node, dict):
            node.pop('default', None)
            if 'prefixItems' in node:
                items = node.pop('prefixItems')
                if not items or any(item != items[0] for item in items):
                    raise ValueError('Only homogeneous tuples are supported in model schemas')
                node.update(items=items[0], minItems=len(items), maxItems=len(items))
            if node.get('type') == 'object':
                node['additionalProperties'] = False
                node['required'] = list(node.get('properties', {}))
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)
    walk(schema)
    return schema
