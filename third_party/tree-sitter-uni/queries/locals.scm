; Scopes
[
  (function_declaration)
  (function_signature)
  (test_declaration)
  (closure_expression)
  (block)
  (for_statement)
  (match_arm)
] @local.scope

; Definitions
(parameter name: (identifier) @local.definition)
(closure_parameter name: (identifier) @local.definition)

(variable_declaration pattern: (identifier) @local.definition)
(for_statement pattern: (identifier) @local.definition)
(let_condition pattern: (identifier) @local.definition)
(tuple_binding (identifier) @local.definition)

; Names bound by a pattern are snake_case; PascalCase ones are enum variants.
((match_arm pattern: (identifier) @local.definition)
  (#match? @local.definition "^[a-z_]"))
((variant_pattern (identifier) @local.definition)
  (#match? @local.definition "^[a-z_]"))
((tuple_pattern (identifier) @local.definition)
  (#match? @local.definition "^[a-z_]"))
(mut_pattern (identifier) @local.definition)

; References
(identifier) @local.reference
