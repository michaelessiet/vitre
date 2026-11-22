; Highlights for Uni, under the capture names Vitre's themes style.
;
; Derived from michaelessiet/uni-lang `editors/zed/languages/uni/highlights.scm`
; (itself generated from `editors/tree-sitter-uni/queries/highlights.scm`),
; MIT; see third_party/tree-sitter-uni/VENDOR.md. The grammar's own query uses
; Neovim names (`@keyword.function`, `@comment.documentation`, `@character`,
; `@variable.builtin`, `@module`), several of which no Vitre theme key or
; parent of one matches. Here every capture is a key of the highlighter's
; theme (`SyntaxColors`) or a dotted child of one, which inherits its parent.
;
; Where several patterns capture the same node the LAST one wins, so general
; patterns come first.

; ---------- identifiers ----------

(identifier) @variable

(self) @variable.special

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

(struct_declaration name: (identifier) @type)
(enum_declaration name: (identifier) @type)
(interface_declaration name: (identifier) @type)
(type_alias name: (identifier) @type)
(type_parameter name: (identifier) @type)

; Module names (`import a.b`, `math.sqrt`) stay `@variable`: the theme has no
; module or namespace colour.

; ---------- functions ----------

(call_expression
  function: (identifier) @function)
(call_expression
  function: (generic_expression value: (identifier) @function))
(call_expression
  function: (field_expression field: (identifier) @function.method))
(call_expression
  function: (generic_expression
    value: (field_expression field: (identifier) @function.method)))

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
(float_literal) @number
(boolean_literal) @boolean
(null_literal) @constant.builtin
((identifier) @constant.builtin
  (#eq? @constant.builtin "None"))
(char_literal) @string

(string_literal "\"" @string)
(c_string_literal ["c\"" "\""] @string)
(string_content) @string
(escape_sequence) @string.escape
(format_spec) @string.special

; ---------- comments ----------

(comment) @comment
(doc_comment) @comment.doc

; ---------- keywords ----------

[
  "const"
  "var"
  "test"
  "implements"
  "assert"
  "defer"
] @keyword

"fn" @keyword

[
  "struct"
  "enum"
  "interface"
  "type"
] @keyword

"import" @keyword
; `pkg` in `import pkg a.b`, `c` and `link` in `import c "m.h" link "m"`
(import_declaration modifier: (identifier) @keyword)

[
  "mut"
  "own"
  "shared"
  "weak"
  "any"
  "extern"
  "unsafe"
] @keyword

(visibility_modifier) @keyword

"return" @keyword

[
  "if"
  "else"
  "match"
] @keyword

[
  "for"
  "while"
  "in"
  "break"
  "continue"
] @keyword

[
  "async"
  "await"
] @keyword

"as" @keyword

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

; ---------- enum variants and interpolation ----------

(enum_variant name: (identifier) @variant)

(interpolation) @embedded
