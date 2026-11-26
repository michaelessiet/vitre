; Indentation, in the nvim-treesitter vocabulary.
[
  (block)
  (struct_body)
  (enum_body)
  (interface_body)
  (match_block)
  (initializer_list)
  (import_list)
  (arguments)
  (parameters)
  (closure_parameters)
  (variant_fields)
  (list_expression)
  (tuple_expression)
  (parenthesized_expression)
  (tuple_type)
  (parameter_types)
] @indent.begin

[
  "}"
  ")"
  "]"
] @indent.branch @indent.end

[
  (comment)
  (doc_comment)
] @indent.auto

(string_literal) @indent.ignore
