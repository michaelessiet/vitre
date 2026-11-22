; Highlights for Uni.
;
; When several patterns match one node the LAST one wins (Neovim, Zed,
; Helix 25.07+ and current tree-sitter), so general patterns come first.

; ---------- identifiers ----------

(identifier) @variable

(self) @variable.builtin

; Fields
(field_expression field: (identifier) @property)
(field_declaration name: (identifier) @property)
(field_initializer name: (identifier) @property)

; PascalCase names are types, enum variants and interfaces
((identifier) @type
  (#match? @type "^[A-Z]"))

; UPPER_SNAKE_CASE names are constants
((identifier) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]+$"))

(const_declaration name: (identifier) @constant)

(enum_variant name: (identifier) @constant)

; ---------- types ----------

(type_identifier) @type

((type_identifier) @type.builtin
  (#any-of? @type.builtin
    "i8" "i16" "i32" "i64" "u8" "u16" "u32" "u64" "f32" "f64" "bool" "char" "str"
    "String" "List" "Map" "Set" "Box" "Result" "Error" "Task" "Arena"))

((identifier) @type.builtin
  (#any-of? @type.builtin "String" "List" "Map" "Set" "Box" "Result" "Error" "Task" "Arena"))

(void_type) @type.builtin

(struct_declaration name: (identifier) @type.definition)
(enum_declaration name: (identifier) @type.definition)
(interface_declaration name: (identifier) @type.definition)
(type_alias name: (identifier) @type.definition)
(type_parameter name: (identifier) @type.definition)

; ---------- modules ----------

(module_path (identifier) @module)
(import_declaration alias: (identifier) @module)
(qualified_type module: (identifier) @module)

; ---------- functions ----------

(call_expression
  function: (identifier) @function.call)
(call_expression
  function: (generic_expression value: (identifier) @function.call))
(call_expression
  function: (field_expression field: (identifier) @function.method.call))
(call_expression
  function: (generic_expression
    value: (field_expression field: (identifier) @function.method.call)))

; `Some(x)`, `Shape.Circle(1.0)`
((call_expression
  function: (identifier) @constructor)
  (#match? @constructor "^[A-Z]"))
((call_expression
  function: (field_expression field: (identifier) @constructor))
  (#match? @constructor "^[A-Z]"))

(variant_pattern name: (identifier) @constructor)

((call_expression
  function: (identifier) @function.builtin)
  (#any-of? @function.builtin
    "print" "eprint" "error" "panic" "spawn" "size_of" "ref_count" "same" "alloc" "free"))

(function_declaration name: (identifier) @function)
(function_signature name: (identifier) @function)
(struct_body (function_declaration name: (identifier) @function.method))
(enum_body (function_declaration name: (identifier) @function.method))
(interface_body (function_signature name: (identifier) @function.method))

; ---------- parameters ----------

(parameter name: (identifier) @variable.parameter)
(closure_parameter name: (identifier) @variable.parameter)
(argument name: (identifier) @variable.parameter)

; ---------- attributes ----------

(attribute "@" @attribute)
(attribute name: (identifier) @attribute)

; ---------- literals ----------

(integer_literal) @number
(float_literal) @number.float
(boolean_literal) @boolean
(null_literal) @constant.builtin
((identifier) @constant.builtin
  (#eq? @constant.builtin "None"))
(char_literal) @character

(string_literal "\"" @string)
(c_string_literal ["c\"" "\""] @string)
(string_content) @string
(escape_sequence) @string.escape
(format_spec) @string.special

; ---------- comments ----------

(comment) @comment
(doc_comment) @comment.documentation

; ---------- keywords ----------

[
  "const"
  "var"
  "test"
  "implements"
  "assert"
  "defer"
] @keyword

"fn" @keyword.function

[
  "struct"
  "enum"
  "interface"
  "type"
] @keyword.type

"import" @keyword.import
; `pkg` in `import pkg a.b`, `c` and `link` in `import c "m.h" link "m"`
(import_declaration modifier: (identifier) @keyword.import)

[
  "mut"
  "own"
  "shared"
  "weak"
  "any"
  "extern"
  "unsafe"
] @keyword.modifier

(visibility_modifier) @keyword.modifier

"return" @keyword.return

[
  "if"
  "else"
  "match"
] @keyword.conditional

[
  "for"
  "while"
  "in"
  "break"
  "continue"
] @keyword.repeat

[
  "async"
  "await"
] @keyword.coroutine

"as" @keyword.operator

; ---------- operators and punctuation ----------

[
  "+" "-" "*" "/" "%" "+%" "-%" "*%"
  "==" "!=" "<" "<=" ">" ">="
  "&&" "||" "!" "??" "?"
  "&" "|" "^" "~" "<<" ">>"
  "=" "+=" "-=" "*=" "/=" "%=" "&=" "|=" "^=" "<<=" ">>="
  ".." "..=" "=>"
] @operator

[
  "(" ")" "[" "]" "{" "}"
] @punctuation.bracket

(type_arguments ["<" ">"] @punctuation.bracket)
(type_parameters ["<" ">"] @punctuation.bracket)

[
  "," "." ":" ";"
] @punctuation.delimiter

; `"{expr:spec}"`: the expression between the braces is highlighted as code
(interpolation ["{" "}"] @punctuation.special)
