/*
 * cdt native client. Does exactly what bin/cdt.js does on its hot path: send
 * argv to the running daemon, print the reply. It starts in a few
 * milliseconds where Node needs over a hundred.
 *
 * Anything else (daemon not running, start/stop, --version, stdin input) is
 * handed to bin/cdt.js, so behaviour stays defined in one place.
 *
 * Wire format (see src/daemon.js):
 *   -> {"argv":[...],"cwd":"..."}\n
 *   <- "<exit code> <stdout bytes> <stderr bytes>\n" + stdout + stderr
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#else
#include <errno.h>
#include <pwd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
#endif

typedef struct {
  char *data;
  size_t len, cap;
} buf_t;

static void buf_add(buf_t *b, const char *s, size_t n) {
  if (b->len + n + 1 > b->cap) {
    b->cap = (b->len + n + 1) * 2;
    b->data = realloc(b->data, b->cap);
    if (!b->data) exit(1);
  }
  memcpy(b->data + b->len, s, n);
  b->len += n;
  b->data[b->len] = 0;
}

static void buf_str(buf_t *b, const char *s) { buf_add(b, s, strlen(s)); }

/* Appends s as a JSON string. Input is UTF-8 and passes through as is. */
static void buf_json(buf_t *b, const char *s) {
  char esc[8];
  buf_str(b, "\"");
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') {
      esc[0] = '\\';
      esc[1] = (char)c;
      buf_add(b, esc, 2);
    } else if (c < 0x20) {
      snprintf(esc, sizeof esc, "\\u%04x", c);
      buf_add(b, esc, 6);
    } else {
      buf_add(b, s, 1);
    }
  }
  buf_str(b, "\"");
}

/* Mirrors clean() in src/paths.js: anything outside [A-Za-z0-9_-] becomes _. */
static void buf_clean(buf_t *b, const char *s) {
  for (; *s; s++) {
    char c = *s;
    int keep = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
               (c >= '0' && c <= '9') || c == '_' || c == '-';
    buf_add(b, keep ? &c : "_", 1);
  }
}

static int needs_node(int argc, char **argv) {
  if (argc < 2) return 0;
  if (!strcmp(argv[1], "start") || !strcmp(argv[1], "stop") ||
      !strcmp(argv[1], "status") || !strcmp(argv[1], "native") ||
      !strcmp(argv[1], "--version") ||
      !strcmp(argv[1], "-v"))
    return 1;
  for (int i = 1; i < argc; i++)
    if (!strcmp(argv[i], "-")) return 1;
  return 0;
}

/*
 * True once the whole framed reply has arrived. Lets the client return without
 * waiting for end-of-stream, which on Windows trails the data by tens of
 * milliseconds.
 */
static int reply_complete(const buf_t *r) {
  if (!r->data) return 0;
  char *nl = memchr(r->data, '\n', r->len);
  int code;
  unsigned long long out_len, err_len;
  if (!nl || sscanf(r->data, "%d %llu %llu", &code, &out_len, &err_len) != 3) {
    return 0;
  }
  return (size_t)(nl + 1 - r->data) + out_len + err_len <= r->len;
}

/* Prints the framed reply; returns the exit code, or -1 if malformed. */
static int print_reply(const buf_t *r) {
  if (!r->data) return -1;
  char *nl = memchr(r->data, '\n', r->len);
  if (!nl) return -1;
  int code;
  unsigned long long out_len, err_len;
  if (sscanf(r->data, "%d %llu %llu", &code, &out_len, &err_len) != 3) return -1;
  const char *body = nl + 1;
  if ((size_t)(body - r->data) + out_len + err_len > r->len) return -1;
  if (out_len) {
    fwrite(body, 1, (size_t)out_len, stdout);
    fputc('\n', stdout);
  }
  if (err_len) {
    fwrite(body + out_len, 1, (size_t)err_len, stderr);
    fputc('\n', stderr);
  }
  fflush(stdout);
  return code;
}

static void build_request(buf_t *req, int argc, char **argv, const char *cwd) {
  buf_str(req, "{\"argv\":[");
  for (int i = 1; i < argc; i++) {
    if (i > 1) buf_str(req, ",");
    buf_json(req, argv[i]);
  }
  buf_str(req, "],\"cwd\":");
  buf_json(req, cwd);
  buf_str(req, "}\n");
}

#ifdef _WIN32

static char *utf8(const wchar_t *w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
  char *s = malloc((size_t)n);
  WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL);
  return s;
}

/* Appends one argument using the MSVCRT quoting rules. */
static void quote_arg(wchar_t **out, size_t *len, size_t *cap, const wchar_t *arg) {
  size_t need = wcslen(arg) * 2 + 4;
  if (*len + need > *cap) {
    *cap = (*len + need) * 2;
    *out = realloc(*out, *cap * sizeof(wchar_t));
  }
  wchar_t *p = *out + *len;
  if (*len) *p++ = L' ';
  *p++ = L'"';
  size_t slashes = 0;
  for (const wchar_t *c = arg;; c++) {
    if (*c == L'\\') {
      slashes++;
    } else if (*c == L'"' || *c == 0) {
      /* Backslashes before a quote (or the closing quote) are doubled. */
      for (size_t i = 0; i < slashes * 2; i++) *p++ = L'\\';
      slashes = 0;
      if (*c == 0) break;
      *p++ = L'\\';
      *p++ = L'"';
    } else {
      for (size_t i = 0; i < slashes; i++) *p++ = L'\\';
      slashes = 0;
      *p++ = *c;
    }
  }
  *p++ = L'"';
  *p = 0;
  *len = (size_t)(p - *out);
}

static int run_node(int argc, wchar_t **wargv) {
  wchar_t script[MAX_PATH * 2];
  DWORD n = GetModuleFileNameW(NULL, script, MAX_PATH);
  if (!n) return 1;
  wchar_t *slash = wcsrchr(script, L'\\');
  if (!slash) return 1;
  wcscpy(slash, L"\\..\\bin\\cdt.js");

  wchar_t *cmd = NULL;
  size_t len = 0, cap = 0;
  quote_arg(&cmd, &len, &cap, L"node");
  quote_arg(&cmd, &len, &cap, script);
  for (int i = 1; i < argc; i++) quote_arg(&cmd, &len, &cap, wargv[i]);

  STARTUPINFOW si = {sizeof si};
  PROCESS_INFORMATION pi;
  if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
    fprintf(stderr, "cdt: could not run node (is it on PATH?)\n");
    return 1;
  }
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  return (int)code;
}

int wmain(int argc, wchar_t **wargv) {
  char **argv = malloc(sizeof(char *) * (size_t)(argc + 1));
  for (int i = 0; i < argc; i++) argv[i] = utf8(wargv[i]);
  if (needs_node(argc, argv)) return run_node(argc, wargv);

  /* Node writes UTF-8; do the same, untranslated. */
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stderr), _O_BINARY);
  UINT old_cp = GetConsoleOutputCP();
  SetConsoleOutputCP(CP_UTF8);

  wchar_t wuser[257];
  DWORD ulen = 257;
  if (!GetUserNameW(wuser, &ulen)) wcscpy(wuser, L"user");
  buf_t pipe = {0};
  buf_str(&pipe, "\\\\.\\pipe\\cdt-");
  buf_clean(&pipe, utf8(wuser));
  const wchar_t *session = _wgetenv(L"CDT_SESSION");
  if (session && *session) {
    buf_str(&pipe, "-");
    buf_clean(&pipe, utf8(session));
  }

  HANDLE h = CreateFileA(pipe.data, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                         OPEN_EXISTING, 0, NULL);
  if (h == INVALID_HANDLE_VALUE && GetLastError() == ERROR_PIPE_BUSY &&
      WaitNamedPipeA(pipe.data, 2000)) {
    h = CreateFileA(pipe.data, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                    OPEN_EXISTING, 0, NULL);
  }
  if (h == INVALID_HANDLE_VALUE) {
    SetConsoleOutputCP(old_cp);
    return run_node(argc, wargv);
  }

  wchar_t wcwd[32768];
  GetCurrentDirectoryW(32768, wcwd);
  buf_t req = {0};
  build_request(&req, argc, argv, utf8(wcwd));
  DWORD done;
  for (size_t off = 0; off < req.len; off += done) {
    if (!WriteFile(h, req.data + off, (DWORD)(req.len - off), &done, NULL)) break;
  }

  buf_t reply = {0};
  char chunk[65536];
  while (ReadFile(h, chunk, sizeof chunk, &done, NULL) && done) {
    buf_add(&reply, chunk, done);
    if (reply_complete(&reply)) break;
  }
  CloseHandle(h);
  int code = print_reply(&reply);
  SetConsoleOutputCP(old_cp);
  if (code < 0) {
    fprintf(stderr, "cdt: daemon closed the connection\n");
    return 1;
  }
  return code;
}

#else /* POSIX */

static int run_node(char **argv) {
  char exe[4096];
#ifdef __APPLE__
  uint32_t size = sizeof exe;
  if (_NSGetExecutablePath(exe, &size)) return 1;
#else
  ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
  if (n < 0) return 1;
  exe[n] = 0;
#endif
  char *real = realpath(exe, NULL);
  if (!real) return 1;
  char *slash = strrchr(real, '/');
  if (!slash) return 1;
  *slash = 0;
  buf_t script = {0};
  buf_str(&script, real);
  buf_str(&script, "/../bin/cdt.js");

  int argc = 0;
  while (argv[argc]) argc++;
  char **args = malloc(sizeof(char *) * (size_t)(argc + 2));
  args[0] = "node";
  args[1] = script.data;
  for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
  args[argc + 1] = NULL;
  execvp("node", args);
  fprintf(stderr, "cdt: could not run node (is it on PATH?)\n");
  return 1;
}

/* Mirrors os.tmpdir() in Node. */
static const char *tmp_dir(void) {
  const char *names[] = {"TMPDIR", "TMP", "TEMP"};
  for (int i = 0; i < 3; i++) {
    const char *v = getenv(names[i]);
    if (v && *v) return v;
  }
  return "/tmp";
}

int main(int argc, char **argv) {
  if (needs_node(argc, argv)) return run_node(argv);

  buf_t path = {0};
  const char *runtime = getenv("XDG_RUNTIME_DIR");
  buf_str(&path, runtime && *runtime ? runtime : tmp_dir());
  while (path.len > 1 && path.data[path.len - 1] == '/') path.data[--path.len] = 0;
  buf_str(&path, "/cdt-");
  struct passwd *pw = getpwuid(geteuid());
  buf_clean(&path, pw ? pw->pw_name : "user");
  const char *session = getenv("CDT_SESSION");
  if (session && *session) {
    buf_str(&path, "-");
    buf_clean(&path, session);
  }
  buf_str(&path, ".sock");

  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  if (path.len >= sizeof addr.sun_path) return run_node(argv);
  memcpy(addr.sun_path, path.data, path.len + 1);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0 || connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
    return run_node(argv);
  }

  char cwd[4096];
  if (!getcwd(cwd, sizeof cwd)) cwd[0] = 0;
  buf_t req = {0};
  build_request(&req, argc, argv, cwd);
  for (size_t off = 0; off < req.len;) {
    ssize_t n = write(fd, req.data + off, req.len - off);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    off += (size_t)n;
  }

  buf_t reply = {0};
  char chunk[65536];
  for (;;) {
    ssize_t n = read(fd, chunk, sizeof chunk);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    buf_add(&reply, chunk, (size_t)n);
    if (reply_complete(&reply)) break;
  }
  close(fd);
  int code = print_reply(&reply);
  if (code < 0) {
    fprintf(stderr, "cdt: daemon closed the connection\n");
    return 1;
  }
  return code;
}

#endif
