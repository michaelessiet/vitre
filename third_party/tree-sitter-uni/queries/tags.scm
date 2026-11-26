(source_file
  (function_declaration name: (identifier) @name) @definition.function)

(struct_body
  (function_declaration name: (identifier) @name) @definition.method)
(enum_body
  (function_declaration name: (identifier) @name) @definition.method)
(interface_body
  (function_signature name: (identifier) @name) @definition.method)

(extern_declaration
  (function_signature name: (identifier) @name)) @definition.function

(struct_declaration name: (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(type_alias name: (identifier) @name) @definition.type
(const_declaration name: (identifier) @name) @definition.constant
(import_declaration path: (module_path) @name) @reference.module

(call_expression
  function: (identifier) @name) @reference.call
(call_expression
  function: (field_expression field: (identifier) @name)) @reference.call
(struct_expression
  type: (identifier) @name) @reference.class
