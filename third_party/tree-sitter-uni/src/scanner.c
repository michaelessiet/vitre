// External scanner for tree-sitter-uni. It has no state.
//
//   _newline       a line end that ends a statement
//   _generic_open  `<` opening type arguments in an expression
//   _closure_open  `(` opening the parameters of a closure
//
// See the comment at the top of grammar.js.

#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdint.h>

enum TokenType {
  NEWLINE,
  GENERIC_OPEN,
  CLOSURE_OPEN,
  ERROR_SENTINEL,
};

void *tree_sitter_uni_external_scanner_create(void) { return NULL; }
void tree_sitter_uni_external_scanner_destroy(void *payload) { (void)payload; }
unsigned tree_sitter_uni_external_scanner_serialize(void *payload, char *buffer) {
  (void)payload;
  (void)buffer;
  return 0;
}
void tree_sitter_uni_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  (void)payload;
  (void)buffer;
  (void)length;
}

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }
static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline bool is_ident_char(int32_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

static inline bool is_space(int32_t c) { return c == ' ' || c == '\t' || c == '\r'; }

// Moves past spaces, line ends and `//` comments. Returns false if a `/` that
// does not start a comment was consumed (the caller then gives up).
static bool skip_blank(TSLexer *lexer) {
  for (;;) {
    if (is_space(lexer->lookahead) || lexer->lookahead == '\n') {
      advance(lexer);
    } else if (lexer->lookahead == '/') {
      advance(lexer);
      if (lexer->lookahead != '/') return false;
      while (lexer->lookahead != '\n' && !lexer->eof(lexer)) advance(lexer);
    } else {
      return true;
    }
  }
}

// At the first token of a later line: does it continue the line before?
static bool continues_previous_line(TSLexer *lexer) {
  switch (lexer->lookahead) {
    case '.':
      advance(lexer);
      return lexer->lookahead != '.';
    case '?':
      advance(lexer);
      return lexer->lookahead == '?';
    case '&':
      advance(lexer);
      return lexer->lookahead == '&';
    case '|':
      advance(lexer);
      return lexer->lookahead == '|';
    case 'e': {
      // `else` may start the line after the `}` of an `if`.
      const char *word = "else";
      for (int i = 0; i < 4; i++) {
        if (lexer->lookahead != word[i]) return false;
        advance(lexer);
      }
      return !is_ident_char(lexer->lookahead);
    }
    default:
      return false;
  }
}

// After the opening quote of a string: moves past its closing quote, the way
// the compiler's lexer does (braces of an interpolation pair up, and a string
// inside an interpolation is skipped).
static bool skip_string(TSLexer *lexer) {
  for (;;) {
    if (lexer->eof(lexer)) return false;
    int32_t c = lexer->lookahead;
    advance(lexer);
    switch (c) {
      case '\n':
        return false;
      case '"':
        return true;
      case '\\':
        advance(lexer);
        break;
      case '{': {
        int braces = 0;
        for (;;) {
          if (lexer->eof(lexer)) return false;
          int32_t d = lexer->lookahead;
          advance(lexer);
          if (d == '\n') return false;
          if (d == '}') {
            if (braces == 0) break;
            braces--;
          } else if (d == '{') {
            braces++;
          } else if (d == '"') {
            for (;;) {
              if (lexer->eof(lexer)) return false;
              int32_t e = lexer->lookahead;
              advance(lexer);
              if (e == '\n') return false;
              if (e == '\\') advance(lexer);
              if (e == '"') break;
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

// After a `'`: moves past a character literal.
static void skip_char(TSLexer *lexer) {
  if (lexer->lookahead == '\\') {
    advance(lexer);
    if (lexer->lookahead == 'u') {
      advance(lexer);
      if (lexer->lookahead == '{') {
        while (lexer->lookahead != '}' && lexer->lookahead != '\n' && !lexer->eof(lexer)) advance(lexer);
      }
    }
  }
  if (lexer->lookahead != '\n' && !lexer->eof(lexer)) advance(lexer);
  if (lexer->lookahead == '\'') advance(lexer);
}

// After a `<`: is this `<T, U>` followed by `(`, `.` or `{`? This is the
// compiler's `try_type_args`, done on characters.
static bool scan_type_arguments(TSLexer *lexer) {
  if (lexer->lookahead == '<' || lexer->lookahead == '=') return false;
  int depth = 1;
  bool any = false;
  while (depth > 0) {
    if (lexer->eof(lexer)) return false;
    int32_t c = lexer->lookahead;
    if (c == '<') {
      depth++;
    } else if (c == '>') {
      depth--;
    } else if (is_ident_char(c)) {
      any = true;
    } else if (!(c == ' ' || c == '\t' || c == ',' || c == '?' || c == '*' || c == '.' || c == ':' || c == ';' ||
                 c == '[' || c == ']' || c == '(' || c == ')')) {
      return false;
    }
    advance(lexer);
  }
  if (!any) return false;
  while (is_space(lexer->lookahead)) advance(lexer);
  switch (lexer->lookahead) {
    case '(':
    case '{':
      return true;
    case '.':
      advance(lexer);
      return lexer->lookahead != '.';
    case '\n':
    case '/':
      // A line end is only skipped before a `.`.
      if (!skip_blank(lexer)) return false;
      if (lexer->lookahead != '.') return false;
      advance(lexer);
      return lexer->lookahead != '.';
    default:
      return false;
  }
}

// After a `(`: is the matching `)` followed by `=>`? This is the compiler's
// `is_closure_ahead`.
static bool scan_closure_ahead(TSLexer *lexer) {
  int depth = 1;
  while (depth > 0) {
    if (lexer->eof(lexer)) return false;
    int32_t c = lexer->lookahead;
    advance(lexer);
    switch (c) {
      case '(':
        depth++;
        break;
      case ')':
        depth--;
        break;
      case '"':
        if (!skip_string(lexer)) return false;
        break;
      case '\'':
        skip_char(lexer);
        break;
      case '/':
        if (lexer->lookahead == '/') {
          while (lexer->lookahead != '\n' && !lexer->eof(lexer)) advance(lexer);
        }
        break;
      default:
        break;
    }
  }
  if (!skip_blank(lexer)) return false;
  if (lexer->lookahead != '=') return false;
  advance(lexer);
  return lexer->lookahead == '>';
}

bool tree_sitter_uni_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  (void)payload;

  for (;;) {
    if (is_space(lexer->lookahead)) {
      skip(lexer);
    } else if (lexer->lookahead == '\n') {
      if (valid_symbols[NEWLINE]) {
        advance(lexer);
        lexer->mark_end(lexer);
        lexer->result_symbol = NEWLINE;
        if (!skip_blank(lexer)) return true;
        return !continues_previous_line(lexer);
      }
      skip(lexer);
    } else {
      break;
    }
  }

  if (lexer->lookahead == '<' && valid_symbols[GENERIC_OPEN]) {
    advance(lexer);
    lexer->mark_end(lexer);
    lexer->result_symbol = GENERIC_OPEN;
    return scan_type_arguments(lexer);
  }

  if (lexer->lookahead == '(' && valid_symbols[CLOSURE_OPEN]) {
    advance(lexer);
    lexer->mark_end(lexer);
    lexer->result_symbol = CLOSURE_OPEN;
    return scan_closure_ahead(lexer);
  }

  return false;
}
