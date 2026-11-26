/**
 * @file Tree-sitter grammar for the Uni programming language.
 * @license MIT
 *
 * The grammar follows compiler/src/parser.rs. Three things in Uni cannot be
 * decided by an LR(1) parser alone and are handled by src/scanner.c:
 *
 *  - `_newline`: a line end that ends a statement. It is only produced where
 *    the grammar can accept it, so a newline inside `(` `[`, or after an
 *    operator, is plain whitespace. It is not produced when the next line
 *    starts with `.`, `??`, `&&`, `||` or `else`.
 *  - `_generic_open`: a `<` that opens type arguments in an expression
 *    (`List<i64>.new()`), as opposed to "less than".
 *  - `_closure_open`: a `(` that opens the parameters of a closure
 *    (`(x) => x + 1`), as opposed to a parenthesized expression.
 *
 * Expressions come in two families. In the header of `if`, `while`, `for`
 * and `match` a `{` always opens the body, so the "header" family has no
 * struct literals and no trailing blocks (`_h_*` rules, aliased to the same
 * node names).
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const PREC = {
  closure: -1,
  coalesce: 1,
  or: 2,
  and: 3,
  compare: 4,
  range: 5,
  bitor: 6,
  bitxor: 7,
  bitand: 8,
  shift: 9,
  add: 10,
  mul: 11,
  cast: 12,
  unary: 13,
  try: 14,
  await: 15,
  call: 16,
  type: 17,
};

const BINARY_OPERATORS = [
  ['??', PREC.coalesce],
  ['||', PREC.or],
  ['&&', PREC.and],
  ['==', PREC.compare],
  ['!=', PREC.compare],
  ['<', PREC.compare],
  ['<=', PREC.compare],
  ['>', PREC.compare],
  ['>=', PREC.compare],
  ['..', PREC.range],
  ['..=', PREC.range],
  ['|', PREC.bitor],
  ['^', PREC.bitxor],
  ['&', PREC.bitand],
  ['<<', PREC.shift],
  ['>>', PREC.shift],
  ['+', PREC.add],
  ['-', PREC.add],
  ['+%', PREC.add],
  ['-%', PREC.add],
  ['*', PREC.mul],
  ['/', PREC.mul],
  ['%', PREC.mul],
  ['*%', PREC.mul],
];

// Keywords that may name a method or a field (`fn any(self)`, `type: str`).
const NAME_KEYWORDS = [
  'any', 'as', 'assert', 'async', 'await', 'break', 'const', 'continue', 'defer', 'else', 'enum',
  'extern', 'fn', 'for', 'if', 'implements', 'import', 'in', 'interface', 'match', 'mut', 'own',
  'pub', 'export', 'return', 'shared', 'struct', 'test', 'type', 'unsafe', 'var', 'void', 'weak', 'while',
];
// After a dot every keyword is a name.
const DOT_KEYWORDS = [...NAME_KEYWORDS, 'self', 'true', 'false', 'null'];

/** `rule` separated by commas, with an optional trailing comma. */
function commaSep(rule) {
  return optional(commaSep1(rule));
}

function commaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)), optional(','));
}

/** `rule` separated by commas, no trailing comma. */
function strictCommaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)));
}

/**
 * The expression rules that have an expression on their left edge, in the
 * normal family (`header` false) or the header family.
 */
function expressionFamily(header) {
  const n = name => (header ? `_h_${name}` : name);
  const E = $ => (header ? $._header_expression : $._expression);
  const fieldExpr = $ => (header ? alias($._h_field_expression, $.field_expression) : $.field_expression);

  return {
    [n('binary_expression')]: $ =>
      choice(
        ...BINARY_OPERATORS.map(([operator, precedence]) =>
          prec.left(precedence, seq(field('left', E($)), field('operator', operator), field('right', E($)))),
        ),
      ),

    [n('unary_expression')]: $ =>
      prec(PREC.unary, seq(field('operator', choice('-', '!', '~')), field('operand', E($)))),

    [n('reference_expression')]: $ => prec(PREC.unary, seq('&', field('value', E($)))),

    [n('handle_expression')]: $ =>
      prec(PREC.unary, seq(choice(seq('shared', optional('mut')), 'weak'), field('value', E($)))),

    [n('await_expression')]: $ => prec(PREC.await, seq('await', E($))),

    [n('try_expression')]: $ => prec(PREC.try, seq(E($), '?')),

    [n('unwrap_expression')]: $ => prec(PREC.try, seq(E($), '!')),

    [n('cast_expression')]: $ => prec.left(PREC.cast, seq(field('value', E($)), 'as', field('type', $._type))),

    [n('call_expression')]: $ =>
      prec(
        PREC.call,
        header
          ? seq(field('function', E($)), field('arguments', $.arguments))
          : seq(field('function', E($)), field('arguments', $.arguments), optional(field('trailing', $.block))),
      ),

    [n('index_expression')]: $ =>
      prec(PREC.call, seq(field('value', E($)), '[', field('index', $._expression), ']')),

    [n('field_expression')]: $ =>
      prec(
        PREC.call,
        seq(
          field('value', E($)),
          '.',
          field('field', choice($.identifier, alias(choice(...DOT_KEYWORDS), $.identifier), $.integer_literal)),
        ),
      ),

    [n('deref_expression')]: $ => prec(PREC.call, seq(field('value', E($)), '.', '*')),

    [n('generic_expression')]: $ =>
      prec(
        PREC.call,
        seq(
          field('value', choice($.identifier, fieldExpr($))),
          field('type_arguments', alias($._expression_type_arguments, $.type_arguments)),
        ),
      ),
  };
}

function closure($, body) {
  return prec.right(
    PREC.closure,
    seq(optional('async'), field('parameters', $.closure_parameters), '=>', field('body', choice($.block, body))),
  );
}

const FAMILY_NAMES = Object.keys(expressionFamily(false));

export default grammar({
  name: 'uni',

  word: $ => $.identifier,

  extras: $ => [/[ \t\r\n]/, $.comment, $.doc_comment],

  externals: $ => [$._newline, $._generic_open, $._closure_open, $._error_sentinel],

  inline: $ => [$._member_name],

  conflicts: $ => [],

  rules: {
    source_file: $ => seq(repeat(seq($._item, $._newline)), optional($._item)),

    // ---------- items ----------

    _item: $ =>
      choice(
        $.import_declaration,
        $.function_declaration,
        $.struct_declaration,
        $.enum_declaration,
        $.interface_declaration,
        $.const_declaration,
        $.type_alias,
        $.test_declaration,
        $.extern_declaration,
      ),

    attribute: $ => seq('@', field('name', $.identifier)),

    visibility_modifier: _ => choice('pub', 'export'),

    _modifiers: $ => choice(
      seq(repeat1($.attribute), optional($.visibility_modifier)),
      seq($.visibility_modifier, repeat($.attribute)),
    ),

    import_declaration: $ =>
      seq(
        optional($._modifiers),
        'import',
        choice(
          // import [pkg] a.b [as x]   |   import a.b.{x, y as z}
          seq(
            optional(field('modifier', $.identifier)),
            field('path', alias($._module_path, $.module_path)),
            optional(choice(seq('.', field('names', $.import_list)), seq('as', field('alias', $.identifier)))),
          ),
          // import c "header.h" [link "m"] [as x]
          seq(
            field('modifier', $.identifier),
            field('header', $.string_literal),
            optional(seq(field('modifier', $.identifier), field('library', $.string_literal))),
            optional(seq('as', field('alias', $.identifier))),
          ),
        ),
      ),

    _module_path: $ => choice($.identifier, seq($._module_path, '.', $.identifier)),

    import_list: $ => seq('{', commaSep($.import_item), '}'),

    import_item: $ => seq(field('name', $.identifier), optional(seq('as', field('alias', $.identifier)))),

    const_declaration: $ =>
      seq(
        optional($._modifiers),
        'const',
        field('name', $.identifier),
        optional(seq(':', field('type', $._type))),
        '=',
        field('value', $._expression),
      ),

    type_alias: $ =>
      seq(
        optional($._modifiers),
        'type',
        field('name', $.identifier),
        optional(field('type_parameters', $.type_parameters)),
        '=',
        field('type', $._type),
      ),

    test_declaration: $ => seq(optional($._modifiers), 'test', field('name', $.string_literal), field('body', $.block)),

    extern_declaration: $ => seq(optional($._modifiers), 'extern', $.function_signature),

    function_declaration: $ => seq(optional($._modifiers), $._function_head, field('body', $.block)),

    function_signature: $ => seq(repeat($.attribute), $._function_head),

    _function_head: $ =>
      seq(
        optional('unsafe'),
        optional('async'),
        'fn',
        field('name', $._member_name),
        optional(field('type_parameters', $.type_parameters)),
        field('parameters', $.parameters),
        optional(seq(':', field('return_type', choice($._type, $.reference_type)))),
      ),

    _member_name: $ => choice($.identifier, alias(choice(...NAME_KEYWORDS), $.identifier)),

    type_parameters: $ => seq('<', strictCommaSep1($.type_parameter), '>'),

    type_parameter: $ =>
      seq(field('name', $.identifier), optional(seq(':', field('bound', $._type), repeat(seq('+', field('bound', $._type)))))),

    parameters: $ => seq('(', commaSep($.parameter), ')'),

    parameter: $ =>
      seq(
        optional(choice('mut', 'own')),
        choice(
          $.self,
          seq(
            field('name', $.identifier),
            ':',
            field('type', $._type),
            optional(seq('=', field('default', $._expression))),
          ),
        ),
      ),

    reference_type: $ => seq('&', optional('mut'), $._type),

    implements_clause: $ => seq('implements', strictCommaSep1($._type)),

    struct_declaration: $ =>
      seq(
        optional($._modifiers),
        'struct',
        field('name', $.identifier),
        optional(field('type_parameters', $.type_parameters)),
        optional($.implements_clause),
        field('body', $.struct_body),
      ),

    struct_body: $ =>
      seq(
        '{',
        repeat(seq(choice($.field_declaration, $.function_declaration), choice(',', $._newline))),
        optional(choice($.field_declaration, $.function_declaration)),
        '}',
      ),

    field_declaration: $ =>
      seq(
        field('name', $._member_name),
        ':',
        field('type', $._type),
        optional(seq('=', field('default', $._expression))),
      ),

    enum_declaration: $ =>
      seq(
        optional($._modifiers),
        'enum',
        field('name', $.identifier),
        optional(field('type_parameters', $.type_parameters)),
        optional($.implements_clause),
        field('body', $.enum_body),
      ),

    enum_body: $ =>
      seq(
        '{',
        repeat(seq(choice($.enum_variant, $.function_declaration), choice(',', $._newline))),
        optional(choice($.enum_variant, $.function_declaration)),
        '}',
      ),

    enum_variant: $ => seq(field('name', $.identifier), optional(field('fields', $.variant_fields))),

    variant_fields: $ => seq('(', commaSep($.field_declaration), ')'),

    interface_declaration: $ =>
      seq(
        optional($._modifiers),
        'interface',
        field('name', $.identifier),
        optional(field('type_parameters', $.type_parameters)),
        field('body', $.interface_body),
      ),

    interface_body: $ =>
      seq('{', repeat(seq($.function_signature, choice(',', $._newline))), optional($.function_signature), '}'),

    // ---------- types ----------

    _type: $ =>
      choice(
        alias($.identifier, $.type_identifier),
        $.generic_type,
        $.qualified_type,
        $.optional_type,
        $.slice_type,
        $.array_type,
        $.tuple_type,
        $.function_type,
        $.pointer_type,
        $.handle_type,
        $.interface_type,
        $.void_type,
      ),

    qualified_type: $ =>
      prec(PREC.type, seq(field('module', $.identifier), '.', field('name', alias($.identifier, $.type_identifier)))),

    generic_type: $ =>
      prec(
        PREC.type,
        seq(field('type', choice(alias($.identifier, $.type_identifier), $.qualified_type)), field('type_arguments', $.type_arguments)),
      ),

    type_arguments: $ => seq('<', strictCommaSep1($._type), '>'),

    _expression_type_arguments: $ => seq(alias($._generic_open, '<'), strictCommaSep1($._type), '>'),

    optional_type: $ => prec(PREC.type, seq($._type, '?')),

    slice_type: $ => seq('[', field('element', $._type), ']'),

    array_type: $ => seq('[', field('element', $._type), ';', field('length', $._expression), ']'),

    tuple_type: $ => seq('(', commaSep1($._type), ')'),

    function_type: $ =>
      prec.right(
        PREC.type,
        seq('fn', field('parameters', $.parameter_types), optional(seq(':', field('return_type', $._type)))),
      ),

    parameter_types: $ => seq('(', commaSep($._type), ')'),

    pointer_type: $ => prec(PREC.type + 1, seq('*', $._type)),

    handle_type: $ => prec(PREC.type + 1, seq(choice('shared', 'weak'), optional('mut'), $._type)),

    interface_type: $ =>
      prec(
        PREC.type + 1,
        seq('any', choice(alias($.identifier, $.type_identifier), $.qualified_type)),
      ),

    void_type: _ => 'void',

    // ---------- statements ----------

    block: $ => seq('{', repeat(seq($._statement, $._newline)), optional($._statement), '}'),

    _statement: $ =>
      choice(
        $.variable_declaration,
        $.assignment_statement,
        $.while_statement,
        $.for_statement,
        $.return_statement,
        $.break_statement,
        $.continue_statement,
        $.assert_statement,
        $.defer_statement,
        $.unsafe_block,
        $.expression_statement,
      ),

    expression_statement: $ => $._expression,

    variable_declaration: $ =>
      seq(
        field('kind', choice('const', 'var')),
        field('pattern', $._binding),
        optional(seq(':', field('type', $._type))),
        '=',
        field('value', $._expression),
      ),

    _binding: $ => choice($.identifier, $.tuple_binding),

    tuple_binding: $ => seq('(', commaSep($._binding), ')'),

    assignment_statement: $ =>
      seq(
        field('left', $._expression),
        field('operator', choice('=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=')),
        field('right', $._expression),
      ),

    while_statement: $ => seq('while', field('condition', $._condition), field('body', $.block)),

    for_statement: $ =>
      seq(
        'for',
        optional('mut'),
        field('pattern', $._binding),
        optional(seq(',', field('pattern', $._binding))),
        'in',
        field('iterable', $._header_expression),
        field('body', $.block),
      ),

    return_statement: $ => seq('return', optional($._expression)),

    break_statement: _ => 'break',

    continue_statement: _ => 'continue',

    assert_statement: $ => seq('assert', $._expression),

    defer_statement: $ => seq('defer', $._expression),

    unsafe_block: $ => seq('unsafe', $.block),

    _condition: $ => choice($._header_expression, $.let_condition),

    let_condition: $ => seq('const', field('pattern', $._binding), '=', field('value', $._header_expression)),

    // ---------- patterns ----------

    _pattern: $ =>
      choice(
        $.identifier,
        $.variant_pattern,
        $.mut_pattern,
        $.tuple_pattern,
        $.negative_literal,
        $.integer_literal,
        $.char_literal,
        $.boolean_literal,
        $.string_literal,
      ),

    variant_pattern: $ => seq(field('name', $.identifier), '(', commaSep($._pattern), ')'),

    mut_pattern: $ => seq('mut', $.identifier),

    tuple_pattern: $ => seq('(', commaSep($._pattern), ')'),

    negative_literal: $ => seq('-', $.integer_literal),

    // ---------- expressions ----------

    _expression: $ => choice(...FAMILY_NAMES.map(name => $[name]), $.struct_expression, $.closure_expression, $._primary_expression),

    _header_expression: $ =>
      choice(
        ...FAMILY_NAMES.map(name => alias($[`_h_${name}`], $[name])),
        alias($._h_closure_expression, $.closure_expression),
        $._primary_expression,
      ),

    ...expressionFamily(false),
    ...expressionFamily(true),

    _primary_expression: $ =>
      choice(
        $.identifier,
        $.self,
        $.integer_literal,
        $.float_literal,
        $.char_literal,
        $.boolean_literal,
        $.null_literal,
        $.string_literal,
        $.c_string_literal,
        $.parenthesized_expression,
        $.tuple_expression,
        $.list_expression,
        $.if_expression,
        $.match_expression,
      ),

    arguments: $ => seq('(', commaSep($.argument), ')'),

    argument: $ =>
      seq(optional(seq(field('name', $._member_name), ':')), optional('mut'), field('value', $._expression)),

    struct_expression: $ =>
      seq(
        field('type', choice($.identifier, $.field_expression, $.generic_expression)),
        field('body', $.initializer_list),
      ),

    initializer_list: $ =>
      seq(
        '{',
        optional(
          choice(
            seq(
              $.field_initializer,
              repeat(seq(choice(',', $._newline), $.field_initializer)),
              optional(choice(',', $._newline)),
            ),
            seq(
              $._collection_entry,
              repeat(seq(choice(',', $._newline), $._collection_entry)),
              optional(choice(',', $._newline)),
            ),
          ),
        ),
        '}',
      ),

    field_initializer: $ => prec(1, seq(field('name', $._member_name), ':', field('value', $._expression))),

    _collection_entry: $ => choice($.map_entry, $._expression),

    map_entry: $ => seq(field('key', $._expression), ':', field('value', $._expression)),

    parenthesized_expression: $ => seq('(', $._expression, ')'),

    tuple_expression: $ => seq('(', $._expression, ',', commaSep($._expression), ')'),

    list_expression: $ => seq('[', commaSep($._expression), ']'),

    closure_expression: $ => closure($, $._expression),

    _h_closure_expression: $ => closure($, $._header_expression),

    closure_parameters: $ => seq(alias($._closure_open, '('), commaSep($.closure_parameter), ')'),

    closure_parameter: $ => seq(field('name', $.identifier), optional(seq(':', field('type', $._type)))),

    if_expression: $ =>
      seq(
        'if',
        field('condition', $._condition),
        field('consequence', $.block),
        optional(field('alternative', $.else_clause)),
      ),

    else_clause: $ => seq('else', choice($.if_expression, $.block)),

    match_expression: $ => seq('match', field('value', $._header_expression), field('body', $.match_block)),

    match_block: $ => seq('{', repeat(seq($.match_arm, choice(',', $._newline))), optional($.match_arm), '}'),

    match_arm: $ =>
      seq(
        field('pattern', $._pattern),
        repeat(seq('|', field('pattern', $._pattern))),
        '=>',
        field('body', choice($.block, $._expression)),
      ),

    // ---------- literals ----------

    self: _ => 'self',

    boolean_literal: _ => choice('true', 'false'),

    null_literal: _ => 'null',

    integer_literal: _ => token(choice(/0[xX][0-9a-fA-F_]+/, /0[bB][01_]+/, /0[oO][0-7_]+/, /[0-9][0-9_]*/)),

    float_literal: _ =>
      token(choice(/[0-9][0-9_]*\.[0-9][0-9_]*([eE][+-]?[0-9]+)?/, /[0-9][0-9_]*[eE][+-]?[0-9]+/)),

    char_literal: _ => token(seq("'", choice(/[^'\\\n]/, /\\u\{[0-9a-fA-F]*\}/, /\\[^\n]/), "'")),

    string_literal: $ =>
      seq('"', repeat(choice($.string_content, $.escape_sequence, $.interpolation)), token.immediate('"')),

    string_content: _ => token.immediate(prec(1, /[^"\\{}\n]+/)),

    escape_sequence: _ => token.immediate(choice(/\\u\{[0-9a-fA-F]*\}/, /\\[^\n]/)),

    interpolation: $ => seq('{', $._expression, optional(seq(':', $.format_spec)), '}'),

    format_spec: _ => token.immediate(choice(/[<>]?[0-9]+(\.[0-9]+)?x?/, /\.[0-9]+x?/, 'x')),

    c_string_literal: $ =>
      seq(
        token(prec(1, 'c"')),
        repeat(choice(alias($._c_string_content, $.string_content), $.escape_sequence)),
        token.immediate('"'),
      ),

    _c_string_content: _ => token.immediate(prec(1, /[^"\\\n]+/)),

    identifier: _ => /[A-Za-z_][A-Za-z0-9_]*/,

    doc_comment: _ => token(prec(1, seq('///', /[^\n]*/))),

    comment: _ => token(seq('//', /[^\n]*/)),
  },
});
