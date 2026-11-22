; Text objects, in the nvim-treesitter-textobjects vocabulary.

(function_declaration
  body: (block) @function.inner) @function.outer
(function_signature) @function.outer
(closure_expression
  body: (_) @function.inner) @function.outer
(test_declaration
  body: (block) @function.inner) @function.outer

(struct_declaration
  body: (struct_body) @class.inner) @class.outer
(enum_declaration
  body: (enum_body) @class.inner) @class.outer
(interface_declaration
  body: (interface_body) @class.inner) @class.outer

(parameter) @parameter.inner @parameter.outer
(closure_parameter) @parameter.inner @parameter.outer
(argument) @parameter.inner @parameter.outer

(call_expression
  arguments: (arguments) @call.inner) @call.outer

(if_expression
  consequence: (block) @conditional.inner) @conditional.outer
(match_expression
  body: (match_block) @conditional.inner) @conditional.outer

(for_statement
  body: (block) @loop.inner) @loop.outer
(while_statement
  body: (block) @loop.inner) @loop.outer

(block) @block.outer

[
  (comment)
  (doc_comment)
] @comment.outer
