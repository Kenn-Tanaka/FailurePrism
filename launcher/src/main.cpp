#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <commctrl.h>
#include <commdlg.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <bcrypt.h>

#include "mini_json.hpp"
#include "resource.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;

namespace {

constexpr const char* kLauncherVersion = "0.0.2";

// -----------------------------------------------------------------------------
// UTF-8 <-> UTF-16 & String Utilities
// -----------------------------------------------------------------------------

std::wstring to_wide(const std::string& utf8) {
    if (utf8.empty()) return L"";
    int needed = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    if (needed <= 0) return L"";
    std::wstring out(static_cast<size_t>(needed), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), needed);
    return out;
}

std::string to_utf8(const std::wstring& wide) {
    if (wide.empty()) return "";
    int needed = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
    if (needed <= 0) return "";
    std::string out(static_cast<size_t>(needed), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), out.data(), needed, nullptr, nullptr);
    return out;
}

std::string path_to_utf8(const fs::path& p) {
    return to_utf8(p.wstring());
}

std::string to_lower_ascii(std::string s) {
    for (char& c : s) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return s;
}

std::wstring to_lower_wide(std::wstring s) {
    for (wchar_t& c : s) {
        c = static_cast<wchar_t>(std::towlower(c));
    }
    return s;
}

std::string trim_ascii(const std::string& s) {
    size_t b = 0;
    while (b < s.size() && (s[b] == ' ' || s[b] == '\t' || s[b] == '\r' || s[b] == '\n')) ++b;
    size_t e = s.size();
    while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\r' || s[e - 1] == '\n')) --e;
    return s.substr(b, e - b);
}

std::wstring get_env_wide(const wchar_t* name) {
    DWORD needed = GetEnvironmentVariableW(name, nullptr, 0);
    if (needed == 0) return L"";
    std::wstring val(static_cast<size_t>(needed), L'\0');
    DWORD written = GetEnvironmentVariableW(name, val.data(), needed);
    if (written == 0) return L"";
    val.resize(static_cast<size_t>(written));
    return val;
}

std::wstring quote_windows_arg(const std::wstring& arg) {
    if (arg.empty()) return L"\"\"";
    bool needs_quotes = false;
    for (wchar_t c : arg) {
        if (c == L' ' || c == L'\t' || c == L'"') {
            needs_quotes = true;
            break;
        }
    }
    if (!needs_quotes) return arg;

    std::wstring out = L"\"";
    size_t slashes = 0;
    for (wchar_t c : arg) {
        if (c == L'\\') {
            ++slashes;
            continue;
        }
        if (c == L'"') {
            out.append(slashes * 2 + 1, L'\\');
            out.push_back(L'"');
        } else {
            out.append(slashes, L'\\');
            out.push_back(c);
        }
        slashes = 0;
    }
    out.append(slashes * 2, L'\\');
    out.push_back(L'"');
    return out;
}

std::vector<std::string> split_command_line_args_utf8(const std::string& raw) {
    std::vector<std::string> out;
    std::string trimmed = trim_ascii(raw);
    if (trimmed.empty()) return out;
    std::wstring wraw = to_wide(trimmed);
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(wraw.c_str(), &argc);
    if (!argv) return out;
    for (int i = 0; i < argc; ++i) {
        std::string item = trim_ascii(to_utf8(argv[i]));
        if (!item.empty()) out.push_back(std::move(item));
    }
    LocalFree(argv);
    return out;
}

std::optional<std::string> read_file_utf8(const fs::path& p) {
    std::ifstream ifs(p, std::ios::binary);
    if (!ifs) return std::nullopt;
    std::ostringstream ss;
    ss << ifs.rdbuf();
    return ss.str();
}

bool write_file_utf8(const fs::path& p, const std::string& content) {
    std::error_code ec;
    if (p.has_parent_path()) {
        fs::create_directories(p.parent_path(), ec);
    }
    std::ofstream ofs(p, std::ios::binary | std::ios::trunc);
    if (!ofs) return false;
    ofs.write(content.data(), static_cast<std::streamsize>(content.size()));
    return ofs.good();
}

// -----------------------------------------------------------------------------
// Console / GUI Output Channel
// -----------------------------------------------------------------------------

class OutputChannel {
public:
    OutputChannel() {
        HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
        if (hOut != nullptr && hOut != INVALID_HANDLE_VALUE) {
            DWORD ftype = GetFileType(hOut);
            if (ftype != FILE_TYPE_UNKNOWN) {
                stdout_handle_ = hOut;
                is_console_handle_ = (ftype == FILE_TYPE_CHAR);
                has_output_ = true;
            }
        }
        if (!has_output_) {
            if (AttachConsole(ATTACH_PARENT_PROCESS)) {
                attached_parent_ = true;
                HANDLE hCon = CreateFileW(
                    L"CONOUT$",
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    nullptr,
                    OPEN_EXISTING,
                    0,
                    nullptr
                );
                if (hCon != INVALID_HANDLE_VALUE) {
                    stdout_handle_ = hCon;
                    owns_handle_ = true;
                    is_console_handle_ = true;
                    has_output_ = true;
                }
            }
        }
        HANDLE hErr = GetStdHandle(STD_ERROR_HANDLE);
        if (hErr != nullptr && hErr != INVALID_HANDLE_VALUE && GetFileType(hErr) != FILE_TYPE_UNKNOWN) {
            stderr_handle_ = hErr;
            stderr_is_console_ = (GetFileType(hErr) == FILE_TYPE_CHAR);
        } else if (has_output_) {
            stderr_handle_ = stdout_handle_;
            stderr_is_console_ = is_console_handle_;
        }
    }

    ~OutputChannel() {
        if (owns_handle_ && stdout_handle_ != INVALID_HANDLE_VALUE) {
            CloseHandle(stdout_handle_);
        }
        if (attached_parent_) {
            FreeConsole();
        }
    }

    bool has_console_or_pipe() const noexcept { return has_output_; }

    void print(const std::string& utf8) const {
        if (!has_output_ || stdout_handle_ == INVALID_HANDLE_VALUE) return;
        write_to(stdout_handle_, is_console_handle_, utf8);
    }

    void println(const std::string& utf8) const {
        print(utf8 + "\n");
    }

    void error_msg(const std::string& title_utf8, const std::string& body_utf8) const {
        if (stderr_handle_ != INVALID_HANDLE_VALUE) {
            write_to(stderr_handle_, stderr_is_console_, "[ERROR] " + title_utf8 + ": " + body_utf8 + "\n");
        }
        if (!has_output_) {
            std::wstring wtitle = to_wide(title_utf8);
            std::wstring wbody = to_wide(body_utf8);
            MessageBoxW(nullptr, wbody.c_str(), wtitle.c_str(), MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
        }
    }

    void info_dialog_or_print(const std::string& title_utf8, const std::string& body_utf8) const {
        if (has_output_) {
            println(body_utf8);
        } else {
            std::wstring wtitle = to_wide(title_utf8);
            std::wstring wbody = to_wide(body_utf8);
            MessageBoxW(nullptr, wbody.c_str(), wtitle.c_str(), MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND);
        }
    }

private:
    static void write_to(HANDLE h, bool is_console, const std::string& utf8) {
        if (utf8.empty()) return;
        if (is_console) {
            std::wstring w = to_wide(utf8);
            DWORD written = 0;
            WriteConsoleW(h, w.data(), static_cast<DWORD>(w.size()), &written, nullptr);
        } else {
            DWORD written = 0;
            WriteFile(h, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
        }
    }

    HANDLE stdout_handle_ = INVALID_HANDLE_VALUE;
    HANDLE stderr_handle_ = INVALID_HANDLE_VALUE;
    bool has_output_ = false;
    bool is_console_handle_ = false;
    bool stderr_is_console_ = false;
    bool attached_parent_ = false;
    bool owns_handle_ = false;
};

// -----------------------------------------------------------------------------
// SHA-256 Helper (via Windows CNG bcrypt.dll)
// -----------------------------------------------------------------------------

std::string compute_file_sha256_prefix12(const fs::path& file_path) {
    std::ifstream ifs(file_path, std::ios::binary);
    if (!ifs) return "";

    BCRYPT_ALG_HANDLE hAlg = nullptr;
    BCRYPT_HASH_HANDLE hHash = nullptr;
    std::string hex_out;

    if (BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0) {
        DWORD obj_len = 0;
        DWORD cb_data = 0;
        if (BCryptGetProperty(hAlg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&obj_len), sizeof(obj_len), &cb_data, 0) == 0) {
            std::vector<UCHAR> hash_obj(obj_len);
            if (BCryptCreateHash(hAlg, &hHash, hash_obj.data(), obj_len, nullptr, 0, 0) == 0) {
                char buf[8192];
                bool ok = true;
                while (ifs) {
                    ifs.read(buf, sizeof(buf));
                    std::streamsize n = ifs.gcount();
                    if (n > 0) {
                        if (BCryptHashData(hHash, reinterpret_cast<PUCHAR>(buf), static_cast<ULONG>(n), 0) != 0) {
                            ok = false;
                            break;
                        }
                    }
                }
                UCHAR digest[32] = {};
                if (ok && BCryptFinishHash(hHash, digest, sizeof(digest), 0) == 0) {
                    const char* hex = "0123456789abcdef";
                    for (int i = 0; i < 6; ++i) {
                        hex_out.push_back(hex[(digest[i] >> 4) & 0xF]);
                        hex_out.push_back(hex[digest[i] & 0xF]);
                    }
                }
                BCryptDestroyHash(hHash);
            }
        }
        BCryptCloseAlgorithmProvider(hAlg, 0);
    }
    return hex_out;
}

// -----------------------------------------------------------------------------
// Browser Discovery & Configuration
// -----------------------------------------------------------------------------

struct BrowserInfo {
    std::string id;
    std::string name;
    fs::path exe_path;
    bool is_chromium = false;
};

struct ResolvedBrowserConfig {
    std::string source = "default";   // cli | env | config | runtime_config | default
    std::string mode = "default";     // default | browser | none
    std::string browser;
    std::string executable_path;
    bool app_mode = false;
    std::vector<std::string> extra_args;
    std::string start_hash = "#menu";
    uint16_t web_port = 3000;
    uint16_t gateway_port = 8765;
};

bool is_chromium_executable(const fs::path& exe_path) {
    std::string leaf = to_lower_ascii(path_to_utf8(exe_path.filename()));
    return leaf == "chrome.exe" || leaf == "msedge.exe" || leaf == "brave.exe" ||
           leaf == "vivaldi.exe" || leaf == "opera.exe" || leaf == "chromium.exe" ||
           leaf == "arc.exe" || leaf == "island.exe";
}

std::wstring extract_exe_from_command(const std::wstring& raw_cmd) {
    size_t b = 0;
    while (b < raw_cmd.size() && std::iswspace(raw_cmd[b])) ++b;
    if (b >= raw_cmd.size()) return L"";
    if (raw_cmd[b] == L'"') {
        size_t endq = raw_cmd.find(L'"', b + 1);
        if (endq != std::wstring::npos && endq > b + 1) {
            return raw_cmd.substr(b + 1, endq - b - 1);
        }
    }
    std::wstring lower = to_lower_wide(raw_cmd.substr(b));
    size_t exe_pos = lower.find(L".exe");
    if (exe_pos != std::wstring::npos) {
        return raw_cmd.substr(b, exe_pos + 4);
    }
    size_t sp = b;
    while (sp < raw_cmd.size() && !std::iswspace(raw_cmd[sp])) ++sp;
    return raw_cmd.substr(b, sp - b);
}

std::wstring read_reg_default_string(HKEY root, const std::wstring& subkey) {
    HKEY hKey = nullptr;
    if (RegOpenKeyExW(root, subkey.c_str(), 0, KEY_READ, &hKey) != ERROR_SUCCESS) {
        return L"";
    }
    wchar_t buf[2048] = {};
    DWORD bytes = sizeof(buf) - sizeof(wchar_t);
    DWORD type = 0;
    LONG rc = RegQueryValueExW(hKey, nullptr, nullptr, &type, reinterpret_cast<LPBYTE>(buf), &bytes);
    RegCloseKey(hKey);
    if (rc != ERROR_SUCCESS || (type != REG_SZ && type != REG_EXPAND_SZ)) {
        return L"";
    }
    if (type == REG_EXPAND_SZ) {
        wchar_t exp[2048] = {};
        DWORD n = ExpandEnvironmentStringsW(buf, exp, static_cast<DWORD>(std::size(exp)));
        if (n > 0 && n < std::size(exp)) return std::wstring(exp);
    }
    return std::wstring(buf);
}

std::optional<fs::path> find_exe_in_app_paths(const std::wstring& exe_name) {
    const std::pair<HKEY, std::wstring> roots[] = {
        {HKEY_CURRENT_USER, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + exe_name},
        {HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + exe_name},
        {HKEY_LOCAL_MACHINE, L"SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + exe_name},
    };
    std::error_code ec;
    for (const auto& [hk, sub] : roots) {
        std::wstring val = read_reg_default_string(hk, sub);
        std::wstring parsed = extract_exe_from_command(val);
        if (!parsed.empty() && fs::is_regular_file(parsed, ec)) {
            return fs::weakly_canonical(parsed, ec);
        }
    }
    return std::nullopt;
}

std::optional<fs::path> search_path_for_exe(const std::wstring& exe_name) {
    wchar_t buf[MAX_PATH] = {};
    DWORD n = SearchPathW(nullptr, exe_name.c_str(), L".exe", MAX_PATH, buf, nullptr);
    std::error_code ec;
    if (n > 0 && n < MAX_PATH && fs::is_regular_file(buf, ec)) {
        return fs::weakly_canonical(buf, ec);
    }
    return std::nullopt;
}

struct KnownBrowserDef {
    std::string id;
    std::string name;
    std::vector<std::string> aliases;
    std::vector<std::wstring> exe_names;
    bool is_chromium;
    std::vector<fs::path> candidates;
};

std::vector<KnownBrowserDef> get_known_browser_catalog() {
    std::wstring pf = get_env_wide(L"ProgramFiles");
    std::wstring pfx86 = get_env_wide(L"ProgramFiles(x86)");
    std::wstring local = get_env_wide(L"LOCALAPPDATA");

    auto make_paths = [&](const wchar_t* rel, bool include_local_programs = false) {
        std::vector<fs::path> v;
        if (!pf.empty()) v.push_back(fs::path(pf) / rel);
        if (!pfx86.empty()) v.push_back(fs::path(pfx86) / rel);
        if (!local.empty()) {
            v.push_back(fs::path(local) / rel);
            if (include_local_programs) {
                v.push_back(fs::path(local) / L"Programs" / rel);
            }
        }
        return v;
    };

    return {
        {"chrome", "Google Chrome", {"chrome", "google-chrome", "chrome.exe"}, {L"chrome.exe"}, true,
         make_paths(L"Google\\Chrome\\Application\\chrome.exe")},
        {"msedge", "Microsoft Edge", {"msedge", "edge", "msedge.exe"}, {L"msedge.exe"}, true,
         make_paths(L"Microsoft\\Edge\\Application\\msedge.exe")},
        {"firefox", "Mozilla Firefox", {"firefox", "mozilla-firefox", "firefox.exe"}, {L"firefox.exe"}, false,
         make_paths(L"Mozilla Firefox\\firefox.exe")},
        {"brave", "Brave Browser", {"brave", "brave-browser", "brave.exe"}, {L"brave.exe"}, true,
         make_paths(L"BraveSoftware\\Brave-Browser\\Application\\brave.exe")},
        {"vivaldi", "Vivaldi", {"vivaldi", "vivaldi.exe"}, {L"vivaldi.exe"}, true,
         make_paths(L"Vivaldi\\Application\\vivaldi.exe")},
        {"opera", "Opera", {"opera", "opera.exe"}, {L"opera.exe", L"launcher.exe"}, true,
         make_paths(L"Opera\\opera.exe", true)},
    };
}

std::vector<BrowserInfo> discover_installed_browsers() {
    std::vector<BrowserInfo> out;
    std::set<std::wstring> seen_lower;
    std::error_code ec;

    auto add_unique = [&](const std::string& id, const std::string& name, const fs::path& p, bool is_chrom) {
        fs::path full = fs::weakly_canonical(p, ec);
        if (ec) full = p;
        std::wstring key = to_lower_wide(full.wstring());
        if (seen_lower.insert(key).second) {
            out.push_back(BrowserInfo{id, name, full, is_chrom});
        }
    };

    for (const auto& entry : get_known_browser_catalog()) {
        std::optional<fs::path> found;
        for (const auto& exe : entry.exe_names) {
            found = find_exe_in_app_paths(exe);
            if (found) break;
        }
        if (!found) {
            for (const auto& cand : entry.candidates) {
                if (fs::is_regular_file(cand, ec)) {
                    found = cand;
                    break;
                }
            }
        }
        if (!found) {
            for (const auto& exe : entry.exe_names) {
                found = search_path_for_exe(exe);
                if (found) break;
            }
        }
        if (found) {
            add_unique(entry.id, entry.name, *found, entry.is_chromium);
        }
    }

    const std::pair<HKEY, std::wstring> sm_roots[] = {
        {HKEY_CURRENT_USER, L"SOFTWARE\\Clients\\StartMenuInternet"},
        {HKEY_LOCAL_MACHINE, L"SOFTWARE\\Clients\\StartMenuInternet"},
        {HKEY_LOCAL_MACHINE, L"SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet"},
    };
    for (const auto& [hk, base_sub] : sm_roots) {
        HKEY hRoot = nullptr;
        if (RegOpenKeyExW(hk, base_sub.c_str(), 0, KEY_READ, &hRoot) != ERROR_SUCCESS) continue;
        DWORD idx = 0;
        wchar_t sub_name[256] = {};
        while (true) {
            DWORD name_len = static_cast<DWORD>(std::size(sub_name));
            if (RegEnumKeyExW(hRoot, idx++, sub_name, &name_len, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) {
                break;
            }
            std::wstring sub_key = base_sub + L"\\" + sub_name;
            std::wstring cmd_raw = read_reg_default_string(hk, sub_key + L"\\shell\\open\\command");
            std::wstring exe_str = extract_exe_from_command(cmd_raw);
            if (exe_str.empty() || !fs::is_regular_file(exe_str, ec)) continue;
            fs::path exe_p(exe_str);
            if (to_lower_ascii(path_to_utf8(exe_p.filename())) == "iexplore.exe") continue;

            std::wstring disp_w = read_reg_default_string(hk, sub_key);
            std::string disp = disp_w.empty() ? path_to_utf8(exe_p.stem()) : to_utf8(disp_w);
            std::string slug = to_lower_ascii(path_to_utf8(exe_p.stem()));
            add_unique(slug, disp, exe_p, is_chromium_executable(exe_p));
        }
        RegCloseKey(hRoot);
    }

    return out;
}

std::optional<fs::path> resolve_browser_executable(
    const std::string& browser_spec,
    const std::vector<BrowserInfo>& installed
) {
    std::string spec = trim_ascii(browser_spec);
    if (spec.size() >= 2 && spec.front() == '"' && spec.back() == '"') {
        spec = spec.substr(1, spec.size() - 2);
    }
    if (spec.empty()) return std::nullopt;

    std::error_code ec;
    fs::path direct(to_wide(spec));
    if (fs::is_regular_file(direct, ec)) {
        fs::path full = fs::weakly_canonical(direct, ec);
        return ec ? direct : full;
    }

    std::string lower = to_lower_ascii(spec);
    for (const auto& b : installed) {
        if (to_lower_ascii(b.id) == lower ||
            to_lower_ascii(b.name) == lower ||
            to_lower_ascii(path_to_utf8(b.exe_path.filename())) == lower) {
            if (fs::is_regular_file(b.exe_path, ec)) return b.exe_path;
        }
    }

    for (const auto& entry : get_known_browser_catalog()) {
        bool alias_match = false;
        for (const auto& al : entry.aliases) {
            if (al == lower) {
                alias_match = true;
                break;
            }
        }
        if (alias_match) {
            for (const auto& exe : entry.exe_names) {
                if (auto p = find_exe_in_app_paths(exe)) return p;
            }
            for (const auto& cand : entry.candidates) {
                if (fs::is_regular_file(cand, ec)) return fs::weakly_canonical(cand, ec);
            }
        }
    }

    if (auto p = search_path_for_exe(to_wide(spec))) return p;
    return std::nullopt;
}

std::string normalize_start_hash(const std::string& raw_hash) {
    std::string h = trim_ascii(raw_hash);
    if (h.empty()) return "#menu";
    if (h[0] != '#') return "#" + h;
    return h;
}

bool is_none_token(const std::string& s) {
    std::string l = to_lower_ascii(trim_ascii(s));
    return l == "none" || l == "off" || l == "false" || l == "0";
}

bool is_default_token(const std::string& s) {
    std::string l = to_lower_ascii(trim_ascii(s));
    return l == "default" || l == "system" || l == "auto";
}

// -----------------------------------------------------------------------------
// CLI Parsing & Config Resolution
// -----------------------------------------------------------------------------

struct CliOptions {
    bool show_help = false;
    bool show_version = false;
    bool list_browsers = false;
    bool show_status = false;
    bool stop_services = false;
    bool select_browser_gui = false;
    bool reset_browser = false;
    bool dry_run_json = false;
    bool no_browser = false;
    bool app_mode = false;

    std::string set_browser;
    std::string cli_browser;
    std::string cli_browser_path;
    std::vector<std::string> cli_browser_args;
    std::string start_hash;
    std::optional<fs::path> config_path;
    std::optional<fs::path> root_dir;
    std::string parse_error;
};

CliOptions parse_cli_args(int argc, LPWSTR* argv) {
    CliOptions opt;
    for (int i = 1; i < argc; ++i) {
        std::string arg = to_utf8(argv[i]);
        std::string lower = to_lower_ascii(arg);

        auto require_next = [&](const char* flag_name) -> std::string {
            if (i + 1 >= argc) {
                opt.parse_error = std::string("オプション ") + flag_name + " に値が必要です。";
                return "";
            }
            return to_utf8(argv[++i]);
        };

        if (lower == "--help" || lower == "-h" || lower == "/?" || lower == "-help") {
            opt.show_help = true;
        } else if (lower == "--version" || lower == "-v") {
            opt.show_version = true;
        } else if (lower == "--list-browsers" || lower == "-list") {
            opt.list_browsers = true;
        } else if (lower == "--status" || lower == "-status") {
            opt.show_status = true;
        } else if (lower == "--stop" || lower == "-stop") {
            opt.stop_services = true;
        } else if (lower == "--select-browser" || lower == "--configure-browser") {
            opt.select_browser_gui = true;
        } else if (lower == "--reset-browser" || lower == "-reset") {
            opt.reset_browser = true;
        } else if (lower == "--dry-run-json") {
            opt.dry_run_json = true;
        } else if (lower == "--no-browser" || lower == "-nobrowser") {
            opt.no_browser = true;
        } else if (lower == "--app" || lower == "-appmode") {
            opt.app_mode = true;
        } else if (lower == "--browser" || lower == "-b" || lower == "-browser") {
            opt.cli_browser = require_next("--browser");
        } else if (lower.rfind("--browser=", 0) == 0) {
            opt.cli_browser = arg.substr(10);
        } else if (lower == "--browser-path") {
            opt.cli_browser_path = require_next("--browser-path");
        } else if (lower.rfind("--browser-path=", 0) == 0) {
            opt.cli_browser_path = arg.substr(15);
        } else if (lower == "--set-browser") {
            opt.set_browser = require_next("--set-browser");
        } else if (lower.rfind("--set-browser=", 0) == 0) {
            opt.set_browser = arg.substr(14);
        } else if (lower == "--browser-arg" || lower == "-browserargs") {
            std::string val = require_next("--browser-arg");
            if (!val.empty()) opt.cli_browser_args.push_back(val);
        } else if (lower.rfind("--browser-arg=", 0) == 0) {
            opt.cli_browser_args.push_back(arg.substr(14));
        } else if (lower.rfind("--profile-directory=", 0) == 0 || lower == "--incognito" || lower == "--inprivate") {
            opt.cli_browser_args.push_back(arg);
        } else if (lower == "--view" || lower == "--hash") {
            opt.start_hash = normalize_start_hash(require_next("--view"));
        } else if (lower.rfind("--view=", 0) == 0) {
            opt.start_hash = normalize_start_hash(arg.substr(7));
        } else if (lower.rfind("--hash=", 0) == 0) {
            opt.start_hash = normalize_start_hash(arg.substr(7));
        } else if (lower == "--config") {
            std::string v = require_next("--config");
            if (!v.empty()) opt.config_path = fs::path(to_wide(v));
        } else if (lower.rfind("--config=", 0) == 0) {
            opt.config_path = fs::path(to_wide(arg.substr(9)));
        } else if (lower == "--root") {
            std::string v = require_next("--root");
            if (!v.empty()) opt.root_dir = fs::path(to_wide(v));
        } else if (lower.rfind("--root=", 0) == 0) {
            opt.root_dir = fs::path(to_wide(arg.substr(7)));
        } else {
            opt.parse_error = "不明なオプションです: " + arg + "\n--help で使用可能なオプションを確認できます。";
            break;
        }
    }
    return opt;
}

fs::path resolve_root_dir(const std::optional<fs::path>& explicit_root) {
    std::error_code ec;
    if (explicit_root) {
        fs::path full = fs::weakly_canonical(*explicit_root, ec);
        return ec ? *explicit_root : full;
    }
    wchar_t mod_buf[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, mod_buf, MAX_PATH);
    fs::path exe_dir = fs::path(mod_buf).parent_path();

    fs::path cur = exe_dir;
    for (int depth = 0; depth < 4 && !cur.empty(); ++depth) {
        if (fs::exists(cur / L"app" / L"server.mjs", ec) ||
            fs::exists(cur / L"scripts" / L"server.mjs", ec)) {
            fs::path full = fs::weakly_canonical(cur, ec);
            return ec ? cur : full;
        }
        fs::path parent = cur.parent_path();
        if (parent == cur) break;
        cur = parent;
    }
    fs::path full = fs::weakly_canonical(exe_dir, ec);
    return ec ? exe_dir : full;
}

std::string current_utc_iso8601();

bool save_browser_preference(
    const fs::path& root_dir,
    const fs::path& config_path,
    const std::string& mode,
    const std::string& target,
    const std::string& exe_path,
    bool app_mode,
    const std::vector<std::string>& extra_args
) {
    // 1. Read existing failureprism.config.json (or default) to preserve ports & startHash
    fp_json::Value root_obj = fp_json::Value::make_object();
    if (auto existing = read_file_utf8(config_path)) {
        try {
            root_obj = fp_json::parse(*existing);
        } catch (...) {
            root_obj = fp_json::Value::make_object();
        }
    } else if (auto def_raw = read_file_utf8(root_dir / L"failureprism.config.default.json")) {
        try {
            root_obj = fp_json::parse(*def_raw);
        } catch (...) {
            root_obj = fp_json::Value::make_object();
        }
    }

    if (!root_obj.find("schema_version")) {
        root_obj.set("schema_version", fp_json::Value::make_int(1));
    }

    fp_json::Value browser_obj = fp_json::Value::make_object();
    std::string prev_hash = "#menu";
    if (const auto* old_b = root_obj.find("browser"); old_b && old_b->is_object()) {
        prev_hash = old_b->get_string("startHash", "#menu");
    }

    browser_obj.set("mode", fp_json::Value::make_string(mode));
    browser_obj.set("target", fp_json::Value::make_string(mode == "browser" ? target : ""));
    browser_obj.set("executablePath", fp_json::Value::make_string(mode == "browser" ? exe_path : ""));
    browser_obj.set("appMode", fp_json::Value::make_bool(mode == "browser" ? app_mode : false));
    fp_json::Value args_arr = fp_json::Value::make_array();
    if (mode == "browser") {
        for (const auto& a : extra_args) {
            if (!trim_ascii(a).empty()) args_arr.arr_val.push_back(fp_json::Value::make_string(trim_ascii(a)));
        }
    }
    browser_obj.set("args", std::move(args_arr));
    browser_obj.set("startHash", fp_json::Value::make_string(prev_hash));
    root_obj.set("browser", std::move(browser_obj));

    if (!root_obj.find("ports")) {
        fp_json::Value ports_obj = fp_json::Value::make_object();
        ports_obj.set("web", fp_json::Value::make_int(3000));
        ports_obj.set("gateway", fp_json::Value::make_int(8765));
        root_obj.set("ports", std::move(ports_obj));
    }

    bool ok = write_file_utf8(config_path, fp_json::dump(root_obj, 2));

    // 2. Sync .runtime/browser.json so start-all.bat / select-browser.bat stay consistent
    fs::path runtime_browser_path = root_dir / L".runtime" / L"browser.json";
    std::error_code ec;
    if (mode == "default") {
        fs::remove(runtime_browser_path, ec);
    } else {
        fp_json::Value rt = fp_json::Value::make_object();
        rt.set("version", fp_json::Value::make_int(1));
        rt.set("mode", fp_json::Value::make_string(mode));
        rt.set("browser", fp_json::Value::make_string(mode == "browser" ? target : "none"));
        rt.set("executablePath", fp_json::Value::make_string(mode == "browser" ? exe_path : ""));
        rt.set("appMode", fp_json::Value::make_bool(mode == "browser" ? app_mode : false));
        fp_json::Value rt_args = fp_json::Value::make_array();
        if (mode == "browser") {
            for (const auto& a : extra_args) {
                if (!trim_ascii(a).empty()) rt_args.arr_val.push_back(fp_json::Value::make_string(trim_ascii(a)));
            }
        }
        rt.set("extraArgs", std::move(rt_args));
        rt.set("updatedAt", fp_json::Value::make_string(current_utc_iso8601()));
        write_file_utf8(runtime_browser_path, fp_json::dump(rt, 2));
    }
    return ok;
}

ResolvedBrowserConfig resolve_configuration(
    const fs::path& root_dir,
    const fs::path& config_path,
    const CliOptions& cli,
    bool ensure_default_config_file
) {
    ResolvedBrowserConfig res;
    std::error_code ec;

    if (ensure_default_config_file && !fs::exists(config_path, ec)) {
        fs::path def_cfg = root_dir / L"failureprism.config.default.json";
        if (fs::exists(def_cfg, ec)) {
            fs::copy_file(def_cfg, config_path, fs::copy_options::overwrite_existing, ec);
        }
    }

    // Load ports & file-based browser config from failureprism.config.json if present
    bool matched_file_browser = false;
    if (auto raw = read_file_utf8(config_path)) {
        try {
            fp_json::Value doc = fp_json::parse(*raw);
            if (const auto* ports = doc.find("ports"); ports && ports->is_object()) {
                int64_t wp = ports->get_int("web", 3000);
                int64_t gp = ports->get_int("gateway", 8765);
                if (wp > 0 && wp <= 65535) res.web_port = static_cast<uint16_t>(wp);
                if (gp > 0 && gp <= 65535) res.gateway_port = static_cast<uint16_t>(gp);
            }
            if (const auto* b = doc.find("browser"); b && b->is_object()) {
                std::string sh = trim_ascii(b->get_string("startHash", "#menu"));
                if (!sh.empty()) res.start_hash = normalize_start_hash(sh);

                std::string fmode = to_lower_ascii(trim_ascii(b->get_string("mode", "default")));
                std::string ftarget = trim_ascii(b->get_string("target", b->get_string("browser", "")));
                std::string fexe = trim_ascii(b->get_string("executablePath", ""));
                bool fapp = b->get_bool("appMode", false);
                std::vector<std::string> fargs;
                const fp_json::Value* arr = b->find("args");
                if (!arr) arr = b->find("extraArgs");
                if (arr && arr->is_array()) {
                    for (const auto& item : arr->arr_val) {
                        if (item.is_string() && !trim_ascii(item.str_val).empty()) {
                            fargs.push_back(trim_ascii(item.str_val));
                        }
                    }
                }

                // If user filled target or executablePath in Notepad without changing mode="default", honor it!
                if (fmode == "none" || is_none_token(ftarget)) {
                    res.source = "config";
                    res.mode = "none";
                    res.browser = "none";
                    matched_file_browser = true;
                } else if (fmode == "browser" || (!ftarget.empty() && !is_default_token(ftarget)) || !fexe.empty()) {
                    res.source = "config";
                    res.mode = "browser";
                    res.browser = ftarget;
                    res.executable_path = fexe;
                    res.app_mode = fapp;
                    res.extra_args = std::move(fargs);
                    matched_file_browser = true;
                }
            }
        } catch (...) {
            // Invalid JSON falls back gracefully
        }
    }

    // Fallback to .runtime/browser.json if failureprism.config.json stayed at default
    if (!matched_file_browser) {
        if (auto rt_raw = read_file_utf8(root_dir / L".runtime" / L"browser.json")) {
            try {
                fp_json::Value rt = fp_json::parse(*rt_raw);
                std::string rmode = to_lower_ascii(trim_ascii(rt.get_string("mode", "default")));
                if (rmode == "none") {
                    res.source = "runtime_config";
                    res.mode = "none";
                    res.browser = "none";
                } else if (rmode == "browser") {
                    res.source = "runtime_config";
                    res.mode = "browser";
                    res.browser = trim_ascii(rt.get_string("browser", ""));
                    res.executable_path = trim_ascii(rt.get_string("executablePath", ""));
                    res.app_mode = rt.get_bool("appMode", false);
                    if (const auto* arr = rt.find("extraArgs"); arr && arr->is_array()) {
                        for (const auto& item : arr->arr_val) {
                            if (item.is_string() && !trim_ascii(item.str_val).empty()) {
                                res.extra_args.push_back(trim_ascii(item.str_val));
                            }
                        }
                    }
                }
            } catch (...) {}
        }
    }

    // Environment variable override
    std::string env_browser = trim_ascii(to_utf8(get_env_wide(L"FAILUREPRISM_BROWSER")));
    if (!env_browser.empty()) {
        res.source = "env";
        res.executable_path.clear();
        res.extra_args.clear();
        if (is_none_token(env_browser)) {
            res.mode = "none";
            res.browser = "none";
            res.app_mode = false;
        } else if (is_default_token(env_browser)) {
            res.mode = "default";
            res.browser = "default";
            res.app_mode = false;
        } else {
            res.mode = "browser";
            res.browser = env_browser;
            std::string env_app = to_lower_ascii(trim_ascii(to_utf8(get_env_wide(L"FAILUREPRISM_BROWSER_APP_MODE"))));
            res.app_mode = (env_app == "1" || env_app == "true" || env_app == "yes");
            res.extra_args = split_command_line_args_utf8(to_utf8(get_env_wide(L"FAILUREPRISM_BROWSER_ARGS")));
        }
    }

    // Highest precedence: CLI overrides
    if (!cli.start_hash.empty()) {
        res.start_hash = cli.start_hash;
    }
    if (cli.no_browser) {
        res.source = "cli";
        res.mode = "none";
        res.browser = "none";
        res.executable_path.clear();
        res.app_mode = false;
        res.extra_args.clear();
        return res;
    }
    if (!cli.cli_browser.empty() || !cli.cli_browser_path.empty()) {
        res.source = "cli";
        res.extra_args.clear();
        std::string spec = !cli.cli_browser_path.empty() ? cli.cli_browser_path : cli.cli_browser;
        if (is_none_token(spec)) {
            res.mode = "none";
            res.browser = "none";
            res.executable_path.clear();
            res.app_mode = false;
            return res;
        }
        if (is_default_token(spec)) {
            res.mode = "default";
            res.browser = "default";
            res.executable_path.clear();
            res.app_mode = false;
            return res;
        }
        res.mode = "browser";
        res.browser = cli.cli_browser;
        res.executable_path = cli.cli_browser_path;
        res.app_mode = cli.app_mode;
    } else {
        if (cli.app_mode && res.mode == "browser") {
            res.app_mode = true;
        }
    }

    for (const auto& a : cli.cli_browser_args) {
        if (!trim_ascii(a).empty()) res.extra_args.push_back(trim_ascii(a));
    }

    return res;
}

// -----------------------------------------------------------------------------
// Winsock2 Localhost HTTP & Process Management
// -----------------------------------------------------------------------------

struct HttpResponse {
    int status_code = 0;
    std::string body;
};

bool is_tcp_port_open(uint16_t port, int timeout_ms) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return false;

    u_long nonblock = 1;
    ioctlsocket(s, FIONBIO, &nonblock);

    sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    int rc = connect(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    bool connected = false;
    if (rc == 0) {
        connected = true;
    } else if (WSAGetLastError() == WSAEWOULDBLOCK) {
        fd_set wfds;
        FD_ZERO(&wfds);
        FD_SET(s, &wfds);
        timeval tv = {};
        tv.tv_sec = timeout_ms / 1000;
        tv.tv_usec = (timeout_ms % 1000) * 1000;
        if (select(0, nullptr, &wfds, nullptr, &tv) > 0) {
            int so_err = 0;
            int len = sizeof(so_err);
            if (getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&so_err), &len) == 0 && so_err == 0) {
                connected = true;
            }
        }
    }
    closesocket(s);
    return connected;
}

std::optional<HttpResponse> http_request_localhost(
    uint16_t port,
    const std::string& method,
    const std::string& path,
    int timeout_ms
) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return std::nullopt;

    u_long nonblock = 1;
    ioctlsocket(s, FIONBIO, &nonblock);

    sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    int rc = connect(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    if (rc != 0) {
        if (WSAGetLastError() != WSAEWOULDBLOCK) {
            closesocket(s);
            return std::nullopt;
        }
        fd_set wfds;
        FD_ZERO(&wfds);
        FD_SET(s, &wfds);
        timeval tv = {timeout_ms / 1000, (timeout_ms % 1000) * 1000};
        if (select(0, nullptr, &wfds, nullptr, &tv) <= 0) {
            closesocket(s);
            return std::nullopt;
        }
        int so_err = 0;
        int len = sizeof(so_err);
        if (getsockopt(s, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&so_err), &len) != 0 || so_err != 0) {
            closesocket(s);
            return std::nullopt;
        }
    }

    u_long block = 0;
    ioctlsocket(s, FIONBIO, &block);
    DWORD rw_timeout = static_cast<DWORD>(timeout_ms);
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&rw_timeout), sizeof(rw_timeout));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&rw_timeout), sizeof(rw_timeout));

    std::string req = method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + std::to_string(port) +
                      "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
    if (send(s, req.data(), static_cast<int>(req.size()), 0) == SOCKET_ERROR) {
        closesocket(s);
        return std::nullopt;
    }

    std::string raw;
    char buf[2048];
    while (raw.size() < 16384) {
        int n = recv(s, buf, sizeof(buf), 0);
        if (n <= 0) break;
        raw.append(buf, static_cast<size_t>(n));
    }
    closesocket(s);

    size_t line_end = raw.find("\r\n");
    if (line_end == std::string::npos) return std::nullopt;
    std::string status_line = raw.substr(0, line_end);
    size_t sp1 = status_line.find(' ');
    if (sp1 == std::string::npos) return std::nullopt;
    int code = 0;
    try {
        code = std::stoi(status_line.substr(sp1 + 1, 3));
    } catch (...) {
        return std::nullopt;
    }

    HttpResponse resp;
    resp.status_code = code;
    size_t hdr_end = raw.find("\r\n\r\n");
    if (hdr_end != std::string::npos) {
        resp.body = raw.substr(hdr_end + 4);
    }
    return resp;
}

std::string format_filetime_utc_iso8601(const FILETIME& ft) {
    SYSTEMTIME st = {};
    if (!FileTimeToSystemTime(&ft, &st)) return "";
    char buf[64] = {};
    std::snprintf(
        buf,
        sizeof(buf),
        "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
        st.wYear,
        st.wMonth,
        st.wDay,
        st.wHour,
        st.wMinute,
        st.wSecond,
        st.wMilliseconds
    );
    return std::string(buf);
}

std::string current_utc_iso8601() {
    FILETIME ft = {};
    GetSystemTimeAsFileTime(&ft);
    return format_filetime_utc_iso8601(ft);
}

std::string get_process_start_iso8601(DWORD pid) {
    if (pid == 0) return "";
    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProc) return "";
    FILETIME create_ft = {}, exit_ft = {}, kernel_ft = {}, user_ft = {};
    std::string iso;
    if (GetProcessTimes(hProc, &create_ft, &exit_ft, &kernel_ft, &user_ft)) {
        iso = format_filetime_utc_iso8601(create_ft);
    }
    CloseHandle(hProc);
    return iso;
}

std::optional<fs::path> query_process_exe_path(DWORD pid) {
    if (pid == 0) return std::nullopt;
    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProc) return std::nullopt;
    wchar_t buf[MAX_PATH] = {};
    DWORD sz = MAX_PATH;
    BOOL ok = QueryFullProcessImageNameW(hProc, 0, buf, &sz);
    DWORD exit_code = 0;
    BOOL active = GetExitCodeProcess(hProc, &exit_code) && (exit_code == STILL_ACTIVE);
    CloseHandle(hProc);
    if (!ok || !active) return std::nullopt;
    return fs::path(buf);
}

bool path_is_within_or_equal(const fs::path& candidate, const fs::path& parent_or_target) {
    std::error_code ec;
    fs::path c_full = fs::weakly_canonical(candidate, ec);
    if (ec) c_full = candidate;
    fs::path p_full = fs::weakly_canonical(parent_or_target, ec);
    if (ec) p_full = parent_or_target;

    std::wstring cw = to_lower_wide(c_full.wstring());
    std::wstring pw = to_lower_wide(p_full.wstring());
    while (!pw.empty() && (pw.back() == L'\\' || pw.back() == L'/')) pw.pop_back();
    if (cw == pw) return true;
    return cw.size() > pw.size() && cw.rfind(pw + L"\\", 0) == 0;
}

DWORD find_matching_gateway_pid(const fs::path& gateway_dir, DWORD hinted_pid) {
    if (hinted_pid != 0) {
        if (auto p = query_process_exe_path(hinted_pid)) {
            if (path_is_within_or_equal(*p, gateway_dir)) return hinted_pid;
        }
    }
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W pe = {};
    pe.dwSize = sizeof(pe);
    DWORD matched = 0;
    if (Process32FirstW(snap, &pe)) {
        do {
            if (to_lower_wide(pe.szExeFile) == L"llm-gateway.exe") {
                if (auto p = query_process_exe_path(pe.th32ProcessID)) {
                    if (path_is_within_or_equal(*p, gateway_dir)) {
                        matched = pe.th32ProcessID;
                        break;
                    }
                }
            }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return matched;
}

std::optional<fs::path> find_node_executable() {
    if (auto p = search_path_for_exe(L"node.exe")) return p;
    std::wstring pf = get_env_wide(L"ProgramFiles");
    std::wstring pfx86 = get_env_wide(L"ProgramFiles(x86)");
    std::wstring local = get_env_wide(L"LOCALAPPDATA");
    std::vector<fs::path> cands;
    if (!pf.empty()) cands.push_back(fs::path(pf) / L"nodejs" / L"node.exe");
    if (!pfx86.empty()) cands.push_back(fs::path(pfx86) / L"nodejs" / L"node.exe");
    if (!local.empty()) cands.push_back(fs::path(local) / L"Programs" / L"nodejs" / L"node.exe");
    std::error_code ec;
    for (const auto& c : cands) {
        if (fs::is_regular_file(c, ec)) return c;
    }
    return std::nullopt;
}

struct SpawnedService {
    DWORD pid = 0;
    HANDLE process_handle = nullptr;
    HANDLE stderr_pipe = nullptr;
};

std::string drain_pipe_text(HANDLE pipe) {
    if (!pipe) return "";
    std::string out;
    DWORD avail = 0;
    while (PeekNamedPipe(pipe, nullptr, 0, nullptr, &avail, nullptr) && avail > 0) {
        char buf[512];
        DWORD to_read = avail < sizeof(buf) ? avail : static_cast<DWORD>(sizeof(buf));
        DWORD n = 0;
        if (!ReadFile(pipe, buf, to_read, &n, nullptr) || n == 0) break;
        out.append(buf, n);
        if (out.size() >= 4096) break;
    }
    return trim_ascii(out);
}

bool spawn_background_service(
    const fs::path& exe_path,
    const std::wstring& cmdline_str,
    const fs::path& work_dir,
    SpawnedService& out_svc,
    std::string& error_out
) {
    SECURITY_ATTRIBUTES sa = {};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;

    HANDLE read_pipe = nullptr;
    HANDLE write_pipe = nullptr;
    if (CreatePipe(&read_pipe, &write_pipe, &sa, 0)) {
        SetHandleInformation(read_pipe, HANDLE_FLAG_INHERIT, 0);
    }

    HANDLE nul_out = CreateFileW(
        L"NUL",
        GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        &sa,
        OPEN_EXISTING,
        0,
        nullptr
    );

    STARTUPINFOW si = {};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    if (write_pipe && nul_out != INVALID_HANDLE_VALUE) {
        si.dwFlags |= STARTF_USESTDHANDLES;
        si.hStdOutput = nul_out;
        si.hStdError = write_pipe;
        si.hStdInput = nullptr;
    }

    std::wstring mutable_cmd = cmdline_str;
    std::wstring wexe = exe_path.wstring();
    std::wstring wdir = work_dir.wstring();

    PROCESS_INFORMATION pi = {};
    BOOL ok = CreateProcessW(
        wexe.c_str(),
        mutable_cmd.data(),
        nullptr,
        nullptr,
        (write_pipe && nul_out != INVALID_HANDLE_VALUE) ? TRUE : FALSE,
        CREATE_NO_WINDOW,
        nullptr,
        wdir.c_str(),
        &si,
        &pi
    );

    if (write_pipe) CloseHandle(write_pipe);
    if (nul_out != INVALID_HANDLE_VALUE) CloseHandle(nul_out);

    if (!ok) {
        if (read_pipe) CloseHandle(read_pipe);
        error_out = "プロセスの起動に失敗しました (Win32 Error " + std::to_string(GetLastError()) + "): " + path_to_utf8(exe_path);
        return false;
    }

    CloseHandle(pi.hThread);
    out_svc.pid = pi.dwProcessId;
    out_svc.process_handle = pi.hProcess;
    out_svc.stderr_pipe = read_pipe;
    return true;
}

void close_spawned_handles(SpawnedService& svc) {
    if (svc.stderr_pipe) {
        CloseHandle(svc.stderr_pipe);
        svc.stderr_pipe = nullptr;
    }
    if (svc.process_handle) {
        CloseHandle(svc.process_handle);
        svc.process_handle = nullptr;
    }
}

int stop_failureprism_services(const fs::path& root_dir, uint16_t web_port, uint16_t gw_port, const OutputChannel& out) {
    fs::path proc_json = root_dir / L".runtime" / L"processes.json";
    DWORD meta_web_pid = 0;
    std::string meta_web_start;
    DWORD meta_gw_pid = 0;

    if (auto raw = read_file_utf8(proc_json)) {
        try {
            fp_json::Value doc = fp_json::parse(*raw);
            if (const auto* w = doc.find("webServer"); w && w->is_object()) {
                meta_web_pid = static_cast<DWORD>(w->get_int("pid", 0));
                meta_web_start = w->get_string("startTime", "");
            }
            if (const auto* g = doc.find("gateway"); g && g->is_object()) {
                meta_gw_pid = static_cast<DWORD>(g->get_int("pid", 0));
            }
        } catch (...) {}
    }

    // 1. Stop Web Server
    if (meta_web_pid != 0) {
        if (auto p = query_process_exe_path(meta_web_pid)) {
            std::string leaf = to_lower_ascii(path_to_utf8(p->filename()));
            if (leaf == "node.exe") {
                std::string actual_start = get_process_start_iso8601(meta_web_pid);
                if (meta_web_start.empty() || actual_start.substr(0, 19) == meta_web_start.substr(0, 19)) {
                    HANDLE hProc = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, meta_web_pid);
                    if (hProc) {
                        TerminateProcess(hProc, 0);
                        WaitForSingleObject(hProc, 2000);
                        CloseHandle(hProc);
                        out.println("[OK] FailurePrism Web Server を停止しました (PID: " + std::to_string(meta_web_pid) + ")。");
                    }
                }
            }
        }
    } else if (!is_tcp_port_open(web_port, 120)) {
        out.println("Web Server (port " + std::to_string(web_port) + ") は起動していません。");
    }

    // 2. Stop LLM-Gateway
    fs::path gateway_dir = root_dir / L"gateway";
    DWORD gw_pid = find_matching_gateway_pid(gateway_dir, meta_gw_pid);
    if (gw_pid != 0) {
        http_request_localhost(gw_port, "POST", "/admin/shutdown", 1500);
        bool exited = false;
        for (int i = 0; i < 15; ++i) {
            if (!query_process_exe_path(gw_pid).has_value()) {
                exited = true;
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
        if (!exited) {
            HANDLE hProc = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, gw_pid);
            if (hProc) {
                TerminateProcess(hProc, 0);
                WaitForSingleObject(hProc, 2000);
                CloseHandle(hProc);
            }
        }
        out.println("[OK] LLM-Gateway を停止しました (PID: " + std::to_string(gw_pid) + ")。");
    } else if (!is_tcp_port_open(gw_port, 120)) {
        out.println("LLM-Gateway (port " + std::to_string(gw_port) + ") は起動していません。");
    }

    std::error_code ec;
    fs::remove(proc_json, ec);
    return 0;
}

// -----------------------------------------------------------------------------
// Native Win32 Browser Selection GUI Dialog (--select-browser)
// -----------------------------------------------------------------------------

enum DialogResultAction { kDialogCancel = 0, kDialogSaveOnly = 1, kDialogSaveAndLaunch = 2 };

struct BrowserDialogState {
    const std::vector<BrowserInfo>* installed = nullptr;
    std::string mode = "default";
    std::string target;
    std::string exe_path;
    bool app_mode = false;
    std::string extra_args_str;
    DialogResultAction action = kDialogCancel;

    HWND combo = nullptr;
    HWND path_edit = nullptr;
    HWND browse_btn = nullptr;
    HWND app_check = nullptr;
    HWND args_edit = nullptr;
    HFONT font = nullptr;
    bool done = false;
};

constexpr int IDC_BROWSER_COMBO = 2001;
constexpr int IDC_PATH_EDIT = 2002;
constexpr int IDC_BROWSE_BTN = 2003;
constexpr int IDC_APP_CHECK = 2004;
constexpr int IDC_ARGS_EDIT = 2005;
constexpr int IDC_SAVE_LAUNCH_BTN = 2006;
constexpr int IDC_SAVE_ONLY_BTN = 2007;
constexpr int IDC_CANCEL_BTN = 2008;

std::wstring get_window_text_str(HWND hwnd) {
    int len = GetWindowTextLengthW(hwnd);
    if (len <= 0) return L"";
    std::wstring buf(static_cast<size_t>(len) + 1, L'\0');
    int written = GetWindowTextW(hwnd, buf.data(), len + 1);
    buf.resize(written > 0 ? static_cast<size_t>(written) : 0);
    return buf;
}

void update_dialog_controls_state(BrowserDialogState* st) {
    if (!st || !st->installed) return;
    LRESULT sel = SendMessageW(st->combo, CB_GETCURSEL, 0, 0);
    const int n_inst = static_cast<int>(st->installed->size());
    const int custom_idx = 1 + n_inst;
    const int none_idx = 2 + n_inst;

    if (sel == 0) {
        SetWindowTextW(st->path_edit, L"(OS既定のブラウザを使用)");
        EnableWindow(st->path_edit, FALSE);
        EnableWindow(st->browse_btn, FALSE);
        EnableWindow(st->app_check, FALSE);
        EnableWindow(st->args_edit, FALSE);
    } else if (sel == none_idx) {
        SetWindowTextW(st->path_edit, L"(サーバー起動のみ・ブラウザ自動起動なし)");
        EnableWindow(st->path_edit, FALSE);
        EnableWindow(st->browse_btn, FALSE);
        EnableWindow(st->app_check, FALSE);
        EnableWindow(st->args_edit, FALSE);
    } else if (sel == custom_idx) {
        std::wstring cur = get_window_text_str(st->path_edit);
        if (cur.rfind(L"(", 0) == 0) SetWindowTextW(st->path_edit, to_wide(st->exe_path).c_str());
        EnableWindow(st->path_edit, TRUE);
        EnableWindow(st->browse_btn, TRUE);
        EnableWindow(st->app_check, TRUE);
        EnableWindow(st->args_edit, TRUE);
    } else if (sel >= 1 && sel <= n_inst) {
        const auto& b = (*st->installed)[static_cast<size_t>(sel - 1)];
        SetWindowTextW(st->path_edit, b.exe_path.wstring().c_str());
        EnableWindow(st->path_edit, FALSE);
        EnableWindow(st->browse_btn, FALSE);
        EnableWindow(st->app_check, b.is_chromium ? TRUE : FALSE);
        if (!b.is_chromium) SendMessageW(st->app_check, BM_SETCHECK, BST_UNCHECKED, 0);
        EnableWindow(st->args_edit, TRUE);
    }
}

LRESULT CALLBACK browser_dialog_wndproc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    auto* st = reinterpret_cast<BrowserDialogState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));

    switch (msg) {
        case WM_CREATE: {
            auto* cs = reinterpret_cast<CREATESTRUCTW*>(lParam);
            st = reinterpret_cast<BrowserDialogState*>(cs->lpCreateParams);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(st));
            return 0;
        }
        case WM_COMMAND: {
            if (!st) break;
            int id = LOWORD(wParam);
            int code = HIWORD(wParam);
            if (id == IDC_BROWSER_COMBO && code == CBN_SELCHANGE) {
                update_dialog_controls_state(st);
                return 0;
            }
            if (id == IDC_BROWSE_BTN) {
                wchar_t file_buf[MAX_PATH] = {};
                OPENFILENAMEW ofn = {};
                ofn.lStructSize = sizeof(ofn);
                ofn.hwndOwner = hwnd;
                ofn.lpstrFilter = L"Browser Executable (*.exe)\0*.exe\0All Files (*.*)\0*.*\0";
                ofn.lpstrFile = file_buf;
                ofn.nMaxFile = MAX_PATH;
                ofn.lpstrTitle = L"使用するブラウザ実行ファイル (.exe) を選択";
                ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
                if (GetOpenFileNameW(&ofn)) {
                    st->exe_path = to_utf8(file_buf);
                    SetWindowTextW(st->path_edit, file_buf);
                    bool chrom = is_chromium_executable(fs::path(file_buf));
                    EnableWindow(st->app_check, chrom ? TRUE : FALSE);
                }
                return 0;
            }
            if (id == IDC_SAVE_LAUNCH_BTN || id == IDC_SAVE_ONLY_BTN) {
                LRESULT sel = SendMessageW(st->combo, CB_GETCURSEL, 0, 0);
                const int n_inst = static_cast<int>(st->installed->size());
                const int custom_idx = 1 + n_inst;
                const int none_idx = 2 + n_inst;

                if (sel == 0) {
                    st->mode = "default";
                    st->target.clear();
                    st->exe_path.clear();
                    st->app_mode = false;
                    st->extra_args_str.clear();
                } else if (sel == none_idx) {
                    st->mode = "none";
                    st->target = "none";
                    st->exe_path.clear();
                    st->app_mode = false;
                    st->extra_args_str.clear();
                } else if (sel == custom_idx) {
                    std::wstring p = get_window_text_str(st->path_edit);
                    std::error_code ec;
                    if (p.empty() || !fs::is_regular_file(p, ec)) {
                        MessageBoxW(hwnd, L"有効なブラウザ実行ファイル (.exe) を指定してください。", L"入力エラー", MB_OK | MB_ICONWARNING);
                        return 0;
                    }
                    fs::path fp(p);
                    st->mode = "browser";
                    st->target = to_lower_ascii(path_to_utf8(fp.stem()));
                    st->exe_path = path_to_utf8(fp);
                    st->app_mode = (SendMessageW(st->app_check, BM_GETCHECK, 0, 0) == BST_CHECKED) && is_chromium_executable(fp);
                    st->extra_args_str = to_utf8(get_window_text_str(st->args_edit));
                } else if (sel >= 1 && sel <= n_inst) {
                    const auto& b = (*st->installed)[static_cast<size_t>(sel - 1)];
                    st->mode = "browser";
                    st->target = b.id;
                    st->exe_path = path_to_utf8(b.exe_path);
                    st->app_mode = b.is_chromium && (SendMessageW(st->app_check, BM_GETCHECK, 0, 0) == BST_CHECKED);
                    st->extra_args_str = to_utf8(get_window_text_str(st->args_edit));
                }
                st->action = (id == IDC_SAVE_LAUNCH_BTN) ? kDialogSaveAndLaunch : kDialogSaveOnly;
                st->done = true;
                DestroyWindow(hwnd);
                return 0;
            }
            if (id == IDC_CANCEL_BTN || id == IDCANCEL) {
                st->action = kDialogCancel;
                st->done = true;
                DestroyWindow(hwnd);
                return 0;
            }
            break;
        }
        case WM_CLOSE:
            if (st) {
                st->action = kDialogCancel;
                st->done = true;
            }
            DestroyWindow(hwnd);
            return 0;
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

DialogResultAction show_browser_selector_dialog(
    HINSTANCE hInst,
    const std::vector<BrowserInfo>& installed,
    ResolvedBrowserConfig& io_cfg
) {
    INITCOMMONCONTROLSEX icc = {sizeof(icc), ICC_STANDARD_CLASSES};
    InitCommonControlsEx(&icc);

    BrowserDialogState st;
    st.installed = &installed;
    st.mode = io_cfg.mode;
    st.target = io_cfg.browser;
    st.exe_path = io_cfg.executable_path;
    st.app_mode = io_cfg.app_mode;
    for (size_t i = 0; i < io_cfg.extra_args.size(); ++i) {
        if (i > 0) st.extra_args_str += " ";
        st.extra_args_str += to_utf8(quote_windows_arg(to_wide(io_cfg.extra_args[i])));
    }

    const wchar_t* cls_name = L"FailurePrismBrowserSelectorWnd";
    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = browser_dialog_wndproc;
    wc.hInstance = hInst;
    wc.hIcon = LoadIconW(hInst, MAKEINTRESOURCEW(IDI_APPICON));
    wc.hIconSm = LoadIconW(hInst, MAKEINTRESOURCEW(IDI_APPICON));
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_BTNFACE + 1);
    wc.lpszClassName = cls_name;
    RegisterClassExW(&wc);

    HDC screen_dc = GetDC(nullptr);
    int dpi = screen_dc ? GetDeviceCaps(screen_dc, LOGPIXELSX) : 96;
    if (screen_dc) ReleaseDC(nullptr, screen_dc);
    auto scale = [&](int px) { return MulDiv(px, dpi, 96); };

    int win_w = scale(540);
    int win_h = scale(320);
    int sx = (GetSystemMetrics(SM_CXSCREEN) - win_w) / 2;
    int sy = (GetSystemMetrics(SM_CYSCREEN) - win_h) / 2;

    HWND hwnd = CreateWindowExW(
        WS_EX_DLGMODALFRAME,
        cls_name,
        L"FailurePrism - 起動ブラウザ設定",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
        sx, sy, win_w, win_h,
        nullptr, nullptr, hInst, &st
    );
    if (!hwnd) return kDialogCancel;

    LOGFONTW lf = {};
    lf.lfHeight = -MulDiv(9, dpi, 72);
    lf.lfCharSet = DEFAULT_CHARSET;
    wcscpy_s(lf.lfFaceName, L"Yu Gothic UI");
    st.font = CreateFontIndirectW(&lf);
    auto apply_font = [&](HWND ctrl) {
        if (ctrl && st.font) SendMessageW(ctrl, WM_SETFONT, reinterpret_cast<WPARAM>(st.font), TRUE);
    };

    HWND lbl1 = CreateWindowExW(0, L"STATIC", L"使用するブラウザ:", WS_CHILD | WS_VISIBLE,
                                scale(20), scale(18), scale(480), scale(20), hwnd, nullptr, hInst, nullptr);
    st.combo = CreateWindowExW(0, L"COMBOBOX", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP | CBS_DROPDOWNLIST | WS_VSCROLL,
                               scale(20), scale(42), scale(485), scale(220), hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_BROWSER_COMBO)), hInst, nullptr);

    HWND lbl2 = CreateWindowExW(0, L"STATIC", L"実行ファイルパス (.exe):", WS_CHILD | WS_VISIBLE,
                                scale(20), scale(78), scale(480), scale(20), hwnd, nullptr, hInst, nullptr);
    st.path_edit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL,
                                   scale(20), scale(100), scale(395), scale(26), hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_PATH_EDIT)), hInst, nullptr);
    st.browse_btn = CreateWindowExW(0, L"BUTTON", L"参照...", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                                    scale(423), scale(99), scale(82), scale(28), hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_BROWSE_BTN)), hInst, nullptr);

    st.app_check = CreateWindowExW(0, L"BUTTON", L"アプリウィンドウモードで開く (--app: アドレスバーなしの専用ウィンドウ)",
                                   WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
                                   scale(20), scale(138), scale(485), scale(24), hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_APP_CHECK)), hInst, nullptr);

    HWND lbl3 = CreateWindowExW(0, L"STATIC", L"追加の起動引数 (任意 / 例: --profile-directory=\"Profile 1\"):", WS_CHILD | WS_VISIBLE,
                                scale(20), scale(170), scale(485), scale(20), hwnd, nullptr, hInst, nullptr);
    st.args_edit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", to_wide(st.extra_args_str).c_str(),
                                   WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL,
                                   scale(20), scale(192), scale(485), scale(26), hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_ARGS_EDIT)), hInst, nullptr);

    HWND btn_launch = CreateWindowExW(0, L"BUTTON", L"保存して起動", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON,
                                      scale(165), scale(236), scale(125), scale(32), hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_SAVE_LAUNCH_BTN)), hInst, nullptr);
    HWND btn_save = CreateWindowExW(0, L"BUTTON", L"保存のみ", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                                    scale(300), scale(236), scale(100), scale(32), hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_SAVE_ONLY_BTN)), hInst, nullptr);
    HWND btn_cancel = CreateWindowExW(0, L"BUTTON", L"キャンセル", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
                                      scale(410), scale(236), scale(95), scale(32), hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(IDC_CANCEL_BTN)), hInst, nullptr);

    for (HWND c : {lbl1, st.combo, lbl2, st.path_edit, st.browse_btn, st.app_check, lbl3, st.args_edit, btn_launch, btn_save, btn_cancel}) {
        apply_font(c);
    }

    SendMessageW(st.combo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"システム既定のブラウザ (OS標準)"));
    int initial_sel = 0;
    for (size_t i = 0; i < installed.size(); ++i) {
        std::wstring label = to_wide(installed[i].name + " (" + installed[i].id + ")");
        SendMessageW(st.combo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label.c_str()));
        if (st.mode == "browser" &&
            (to_lower_ascii(installed[i].id) == to_lower_ascii(st.target) ||
             to_lower_wide(installed[i].exe_path.wstring()) == to_lower_wide(to_wide(st.exe_path)))) {
            initial_sel = static_cast<int>(i + 1);
        }
    }
    SendMessageW(st.combo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"任意のブラウザ実行ファイル (.exe) を直接指定..."));
    SendMessageW(st.combo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"ブラウザを自動で開かない (サーバー起動のみ)"));

    if (st.mode == "none") {
        initial_sel = static_cast<int>(installed.size() + 2);
    } else if (st.mode == "browser" && initial_sel == 0) {
        initial_sel = static_cast<int>(installed.size() + 1);
    }
    SendMessageW(st.combo, CB_SETCURSEL, static_cast<WPARAM>(initial_sel), 0);
    SendMessageW(st.app_check, BM_SETCHECK, st.app_mode ? BST_CHECKED : BST_UNCHECKED, 0);
    update_dialog_controls_state(&st);

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);

    MSG m = {};
    while (GetMessageW(&m, nullptr, 0, 0) > 0) {
        if (!IsDialogMessageW(hwnd, &m)) {
            TranslateMessage(&m);
            DispatchMessageW(&m);
        }
    }

    if (st.font) DeleteObject(st.font);

    if (st.action != kDialogCancel) {
        io_cfg.mode = st.mode;
        io_cfg.browser = st.target;
        io_cfg.executable_path = st.exe_path;
        io_cfg.app_mode = st.app_mode;
        io_cfg.extra_args = split_command_line_args_utf8(st.extra_args_str);
    }
    return st.action;
}

// -----------------------------------------------------------------------------
// Usage & Status Helpers
// -----------------------------------------------------------------------------

std::string build_help_text() {
    return
        "FailurePrism Unified Workbench Launcher v" + std::string(kLauncherVersion) + "\n"
        "\n"
        "使い方:\n"
        "  FailurePrism.exe [オプション]\n"
        "\n"
        "起動時ブラウザ指定 (その回のみ一時適用):\n"
        "  --browser <name|path>    使用するブラウザを指定 (chrome, msedge, firefox, brave, vivaldi, opera, default, none, または .exe パス)\n"
        "  --browser-path <path>    ブラウザ実行ファイル (.exe) のフルパスを指定\n"
        "  --app                    Chromium系ブラウザを専用アプリウィンドウ (--app) で起動\n"
        "  --browser-arg <arg>      ブラウザへ追加引数を渡す (複数指定可 / 例: --profile-directory=\"Profile 1\")\n"
        "  --no-browser             LLM-Gateway と Web サーバーのみ起動しブラウザを開かない\n"
        "  --view <menu|tpdd|vta>   初期表示画面を指定 (既定: #menu)\n"
        "  --config <path>          設定ファイルのパスを指定 (既定: failureprism.config.json)\n"
        "\n"
        "ブラウザ設定の保存・管理:\n"
        "  --select-browser         GUIダイアログを開いて起動ブラウザを選択・保存\n"
        "  --set-browser <spec>     指定ブラウザを failureprism.config.json に永続保存 (--app / --browser-arg 併用可)\n"
        "  --reset-browser          起動ブラウザ設定をOS既定ブラウザへリセット\n"
        "  --list-browsers          PC上で検出されたブラウザ一覧を表示\n"
        "  --status                 現在のブラウザ設定とサービス稼働状態を表示\n"
        "  --stop                   起動中の Web Server (:3000) と LLM-Gateway (:8765) を安全に停止\n"
        "  --help, -h               このヘルプを表示\n";
}

} // namespace

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE, PWSTR, int) {
    WSADATA wsa = {};
    WSAStartup(MAKEWORD(2, 2), &wsa);

    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    CliOptions cli = parse_cli_args(argc, argv);
    if (argv) LocalFree(argv);

    OutputChannel out;

    if (!cli.parse_error.empty()) {
        out.error_msg("FailurePrism 引数エラー", cli.parse_error);
        WSACleanup();
        return 2;
    }

    if (cli.show_help) {
        out.info_dialog_or_print("FailurePrism ヘルプ", build_help_text());
        WSACleanup();
        return 0;
    }

    if (cli.show_version) {
        out.info_dialog_or_print("FailurePrism Version", std::string("FailurePrism Launcher v") + kLauncherVersion);
        WSACleanup();
        return 0;
    }

    fs::path root_dir = resolve_root_dir(cli.root_dir);
    fs::path config_path = cli.config_path.has_value()
                               ? *cli.config_path
                               : (root_dir / L"failureprism.config.json");

    std::vector<BrowserInfo> installed = discover_installed_browsers();

    if (cli.list_browsers) {
        std::ostringstream ss;
        ss << "検出されたブラウザ一覧:\n";
        if (installed.empty()) {
            ss << "  (登録済みブラウザが検出されませんでした)\n";
        } else {
            for (const auto& b : installed) {
                ss << "  - " << b.id << " : " << b.name << " (" << path_to_utf8(b.exe_path) << ")"
                   << (b.is_chromium ? " [Chromium/--app対応]" : "") << "\n";
            }
        }
        out.info_dialog_or_print("FailurePrism 検出ブラウザ一覧", ss.str());
        WSACleanup();
        return 0;
    }

    if (cli.reset_browser) {
        if (!save_browser_preference(root_dir, config_path, "default", "", "", false, {})) {
            out.error_msg("FailurePrism 設定保存エラー", "設定ファイルの書き込みに失敗しました: " + path_to_utf8(config_path));
            WSACleanup();
            return 1;
        }
        out.info_dialog_or_print("FailurePrism 設定リセット", "[OK] 起動ブラウザをシステム既定のブラウザ (default) に戻しました。");
        WSACleanup();
        return 0;
    }

    if (!cli.set_browser.empty()) {
        std::string spec = trim_ascii(cli.set_browser);
        if (is_default_token(spec)) {
            save_browser_preference(root_dir, config_path, "default", "", "", false, {});
            out.info_dialog_or_print("FailurePrism 設定保存", "[OK] システム既定のブラウザを使用するよう設定しました。");
            WSACleanup();
            return 0;
        }
        if (is_none_token(spec)) {
            save_browser_preference(root_dir, config_path, "none", "none", "", false, {});
            out.info_dialog_or_print("FailurePrism 設定保存", "[OK] 起動時にブラウザを自動で開かない (none) よう設定しました。");
            WSACleanup();
            return 0;
        }
        auto resolved_exe = resolve_browser_executable(spec, installed);
        if (!resolved_exe) {
            out.error_msg("FailurePrism ブラウザ未検出", "指定されたブラウザが見つかりません: " + spec);
            WSACleanup();
            return 1;
        }
        std::string label = to_lower_ascii(path_to_utf8(resolved_exe->stem()));
        for (const auto& b : installed) {
            if (to_lower_wide(b.exe_path.wstring()) == to_lower_wide(resolved_exe->wstring())) {
                label = b.id;
                break;
            }
        }
        bool app = cli.app_mode && is_chromium_executable(*resolved_exe);
        if (!save_browser_preference(root_dir, config_path, "browser", label, path_to_utf8(*resolved_exe), app, cli.cli_browser_args)) {
            out.error_msg("FailurePrism 設定保存エラー", "設定ファイルの書き込みに失敗しました: " + path_to_utf8(config_path));
            WSACleanup();
            return 1;
        }
        out.info_dialog_or_print(
            "FailurePrism 設定保存",
            "[OK] 起動ブラウザを保存しました: " + label + " (" + path_to_utf8(*resolved_exe) + ")"
        );
        WSACleanup();
        return 0;
    }

    ResolvedBrowserConfig cfg = resolve_configuration(root_dir, config_path, cli, !cli.dry_run_json && !cli.show_status && !cli.stop_services);

    if (cli.stop_services) {
        int rc = stop_failureprism_services(root_dir, cfg.web_port, cfg.gateway_port, out);
        WSACleanup();
        return rc;
    }

    if (cli.show_status) {
        bool gw_up = is_tcp_port_open(cfg.gateway_port, 150);
        bool web_up = is_tcp_port_open(cfg.web_port, 150);
        std::ostringstream ss;
        ss << "FailurePrism ステータス\n"
           << "  Root:        " << path_to_utf8(root_dir) << "\n"
           << "  Config:      " << path_to_utf8(config_path) << "\n"
           << "  Source:      " << cfg.source << "\n"
           << "  BrowserMode: " << cfg.mode << "\n";
        if (cfg.mode == "browser") {
            auto exe_opt = !cfg.executable_path.empty()
                               ? resolve_browser_executable(cfg.executable_path, installed)
                               : resolve_browser_executable(cfg.browser, installed);
            ss << "  Target:      " << (cfg.browser.empty() ? "(path)" : cfg.browser) << "\n"
               << "  Executable:  " << (exe_opt ? path_to_utf8(*exe_opt) : "(未検出 -> OS既定へフォールバック)") << "\n"
               << "  AppMode:     " << (cfg.app_mode ? "true (--app)" : "false") << "\n";
        }
        ss << "  LLM-Gateway: " << (gw_up ? "RUNNING" : "STOPPED") << " (127.0.0.1:" << cfg.gateway_port << ")\n"
           << "  Web Server:  " << (web_up ? "RUNNING" : "STOPPED") << " (127.0.0.1:" << cfg.web_port << ")\n";
        out.info_dialog_or_print("FailurePrism ステータス", ss.str());
        WSACleanup();
        return 0;
    }

    if (cli.select_browser_gui) {
        DialogResultAction act = show_browser_selector_dialog(hInstance, installed, cfg);
        if (act == kDialogCancel) {
            WSACleanup();
            return 0;
        }
        save_browser_preference(root_dir, config_path, cfg.mode, cfg.browser, cfg.executable_path, cfg.app_mode, cfg.extra_args);
        if (act == kDialogSaveOnly) {
            WSACleanup();
            return 0;
        }
    }

    // Resolve server.mjs & index.html build query
    std::error_code ec;
    fs::path server_script = root_dir / L"app" / L"server.mjs";
    if (!fs::is_regular_file(server_script, ec)) {
        server_script = root_dir / L"scripts" / L"server.mjs";
    }
    fs::path served_index = server_script.parent_path() / L"dist" / L"index.html";
    if (!fs::is_regular_file(served_index, ec)) {
        served_index = root_dir / L"dist" / L"index.html";
    }
    std::string build_hash = fs::is_regular_file(served_index, ec) ? compute_file_sha256_prefix12(served_index) : "";
    std::string build_query = build_hash.empty() ? "" : ("?build=" + build_hash);
    std::string browser_url = "http://127.0.0.1:" + std::to_string(cfg.web_port) + "/" + build_query + cfg.start_hash;

    // Resolve browser executable & arguments
    std::optional<fs::path> resolved_browser_exe;
    std::string effective_launch_mode = cfg.mode;
    if (cfg.mode == "browser") {
        if (!cfg.executable_path.empty() && fs::is_regular_file(fs::path(to_wide(cfg.executable_path)), ec)) {
            resolved_browser_exe = fs::weakly_canonical(fs::path(to_wide(cfg.executable_path)), ec);
        }
        if (!resolved_browser_exe && !cfg.browser.empty()) {
            resolved_browser_exe = resolve_browser_executable(cfg.browser, installed);
        }
        if (!resolved_browser_exe) {
            effective_launch_mode = "fallback_default";
        }
    }

    std::vector<std::string> final_browser_args;
    if (effective_launch_mode == "browser" && resolved_browser_exe) {
        for (const auto& a : cfg.extra_args) {
            final_browser_args.push_back(a);
        }
        if (cfg.app_mode && is_chromium_executable(*resolved_browser_exe)) {
            final_browser_args.push_back("--app=" + browser_url);
        } else {
            final_browser_args.push_back(browser_url);
        }
    } else if (effective_launch_mode == "default" || effective_launch_mode == "fallback_default") {
        final_browser_args.push_back(browser_url);
    }

    if (cli.dry_run_json) {
        fp_json::Value j = fp_json::Value::make_object();
        j.set("rootDir", fp_json::Value::make_string(path_to_utf8(root_dir)));
        j.set("configPath", fp_json::Value::make_string(path_to_utf8(config_path)));
        j.set("source", fp_json::Value::make_string(cfg.source));
        j.set("mode", fp_json::Value::make_string(cfg.mode));
        j.set("launchedMode", fp_json::Value::make_string(effective_launch_mode));
        j.set("browser", fp_json::Value::make_string(cfg.browser));
        j.set("resolvedExecutable", fp_json::Value::make_string(resolved_browser_exe ? path_to_utf8(*resolved_browser_exe) : ""));
        j.set("appMode", fp_json::Value::make_bool(cfg.app_mode));
        fp_json::Value jargs = fp_json::Value::make_array();
        for (const auto& a : final_browser_args) {
            jargs.arr_val.push_back(fp_json::Value::make_string(a));
        }
        j.set("arguments", std::move(jargs));
        j.set("url", fp_json::Value::make_string(browser_url));
        j.set("webPort", fp_json::Value::make_int(cfg.web_port));
        j.set("gatewayPort", fp_json::Value::make_int(cfg.gateway_port));
        out.print(fp_json::dump(j, 2));
        WSACleanup();
        return 0;
    }

    // -------------------------------------------------------------------------
    // 1. Check & Start LLM-Gateway (:8765)
    // -------------------------------------------------------------------------
    if (!fs::is_regular_file(server_script, ec)) {
        out.error_msg(
            "FailurePrism 起動エラー",
            "Web サーバースクリプト (server.mjs) が見つかりません。\n検索先: " + path_to_utf8(root_dir)
        );
        WSACleanup();
        return 1;
    }

    auto node_exe = find_node_executable();
    if (!node_exe) {
        out.error_msg(
            "Node.js が見つかりません",
            "FailurePrism Web Server の実行には Node.js (v18以降) が必要です。\nNode.js をインストールしてから再度起動してください。"
        );
        WSACleanup();
        return 1;
    }

    fs::path gw_exe = root_dir / L"gateway" / L"llm-gateway.exe";
    if (!fs::is_regular_file(gw_exe, ec)) {
        gw_exe = root_dir / L"gateway" / L"bin" / L"llm-gateway.exe";
    }
    fs::path gw_dir = fs::is_regular_file(gw_exe, ec) ? gw_exe.parent_path() : (root_dir / L"gateway");
    fs::path gw_cfg = root_dir / L"gateway" / L"config" / L"llm-gateway.json";
    fs::path gw_def_cfg = root_dir / L"gateway" / L"config" / L"llm-gateway.default.json";
    if (!fs::exists(gw_cfg, ec) && fs::exists(gw_def_cfg, ec)) {
        fs::copy_file(gw_def_cfg, gw_cfg, fs::copy_options::overwrite_existing, ec);
    }

    fs::path proc_json = root_dir / L".runtime" / L"processes.json";
    DWORD prev_gw_pid = 0;
    DWORD prev_web_pid = 0;
    if (auto praw = read_file_utf8(proc_json)) {
        try {
            fp_json::Value pdoc = fp_json::parse(*praw);
            if (const auto* g = pdoc.find("gateway"); g && g->is_object()) prev_gw_pid = static_cast<DWORD>(g->get_int("pid", 0));
            if (const auto* w = pdoc.find("webServer"); w && w->is_object()) prev_web_pid = static_cast<DWORD>(w->get_int("pid", 0));
        } catch (...) {}
    }

    DWORD active_gw_pid = 0;
    SpawnedService gw_svc;
    if (is_tcp_port_open(cfg.gateway_port, 120)) {
        DWORD matched_gw = find_matching_gateway_pid(root_dir / L"gateway", prev_gw_pid);
        if (matched_gw == 0) {
            out.error_msg(
                "ポート競合エラー (8765)",
                "ポート " + std::to_string(cfg.gateway_port) +
                    " は別の無関係なプロセスが使用中です。\n競合プロセスを終了するか Gateway のポート設定を変更してください。"
            );
            WSACleanup();
            return 1;
        }
        active_gw_pid = matched_gw;
        out.println("[1/2] 既存の LLM-Gateway インスタンスを再利用します (PID: " + std::to_string(active_gw_pid) + ")。");
    } else if (fs::is_regular_file(gw_exe, ec) && fs::is_regular_file(gw_cfg, ec)) {
        std::wstring gw_cmd = quote_windows_arg(gw_exe.wstring()) + L" --config " + quote_windows_arg(gw_cfg.wstring());
        std::string spawn_err;
        if (!spawn_background_service(gw_exe, gw_cmd, gw_dir, gw_svc, spawn_err)) {
            out.error_msg("LLM-Gateway 起動失敗", spawn_err);
            WSACleanup();
            return 1;
        }
        active_gw_pid = gw_svc.pid;
        auto t0 = std::chrono::steady_clock::now();
        bool gw_ready = false;
        while (std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count() < 12000) {
            if (WaitForSingleObject(gw_svc.process_handle, 0) == WAIT_OBJECT_0) {
                std::string err_detail = drain_pipe_text(gw_svc.stderr_pipe);
                close_spawned_handles(gw_svc);
                out.error_msg("LLM-Gateway 異常終了",
                              "LLM-Gateway が起動直後に終了しました。" + (err_detail.empty() ? "" : ("\n詳細: " + err_detail)));
                WSACleanup();
                return 1;
            }
            if (auto h = http_request_localhost(cfg.gateway_port, "GET", "/health", 200)) {
                if (h->status_code >= 200 && h->status_code < 500) {
                    gw_ready = true;
                    break;
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(80));
        }
        close_spawned_handles(gw_svc);
        if (!gw_ready) {
            out.error_msg("LLM-Gateway タイムアウト", "LLM-Gateway (127.0.0.1:" + std::to_string(cfg.gateway_port) + ") の応答待機がタイムアウトしました。");
            WSACleanup();
            return 1;
        }
        out.println("[1/2] LLM-Gateway を起動しました (PID: " + std::to_string(active_gw_pid) + ")。");
    }

    // -------------------------------------------------------------------------
    // 2. Check & Start FailurePrism Web Server (:3000)
    // -------------------------------------------------------------------------
    DWORD active_web_pid = 0;
    SpawnedService web_svc;
    if (is_tcp_port_open(cfg.web_port, 120)) {
        bool verified_ours = false;
        if (prev_web_pid != 0) {
            if (auto p = query_process_exe_path(prev_web_pid)) {
                if (to_lower_ascii(path_to_utf8(p->filename())) == "node.exe") {
                    verified_ours = true;
                    active_web_pid = prev_web_pid;
                }
            }
        }
        if (!verified_ours) {
            if (auto resp = http_request_localhost(cfg.web_port, "GET", "/", 300)) {
                if (resp->status_code == 200 && resp->body.find("FailurePrism") != std::string::npos) {
                    verified_ours = true;
                }
            }
        }
        if (!verified_ours) {
            out.error_msg(
                "ポート競合エラー (3000)",
                "ポート " + std::to_string(cfg.web_port) +
                    " は別の無関係なプロセスが使用中です。\n競合プロセスを終了してから再度起動してください。"
            );
            WSACleanup();
            return 1;
        }
        out.println("[2/2] 既存の FailurePrism Web Server を再利用します。");
    } else {
        std::wstring web_cmd = quote_windows_arg(node_exe->wstring()) + L" " + quote_windows_arg(server_script.wstring());
        std::string spawn_err;
        if (!spawn_background_service(*node_exe, web_cmd, server_script.parent_path(), web_svc, spawn_err)) {
            out.error_msg("Web Server 起動失敗", spawn_err);
            WSACleanup();
            return 1;
        }
        active_web_pid = web_svc.pid;
        auto t0 = std::chrono::steady_clock::now();
        bool web_ready = false;
        while (std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count() < 12000) {
            if (WaitForSingleObject(web_svc.process_handle, 0) == WAIT_OBJECT_0) {
                std::string err_detail = drain_pipe_text(web_svc.stderr_pipe);
                close_spawned_handles(web_svc);
                out.error_msg("Web Server 異常終了",
                              "FailurePrism Web Server が起動直後に終了しました。" + (err_detail.empty() ? "" : ("\n詳細: " + err_detail)));
                WSACleanup();
                return 1;
            }
            if (auto h = http_request_localhost(cfg.web_port, "GET", "/", 200)) {
                if (h->status_code >= 200 && h->status_code < 500) {
                    web_ready = true;
                    break;
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(80));
        }
        close_spawned_handles(web_svc);
        if (!web_ready) {
            out.error_msg("Web Server タイムアウト", "FailurePrism Web Server (127.0.0.1:" + std::to_string(cfg.web_port) + ") の応答待機がタイムアウトしました。");
            WSACleanup();
            return 1;
        }
        out.println("[2/2] FailurePrism Web Server を起動しました (PID: " + std::to_string(active_web_pid) + ")。");
    }

    // -------------------------------------------------------------------------
    // 3. Persist .runtime/processes.json (100% compatible with stop-all.bat)
    // -------------------------------------------------------------------------
    {
        std::string now_iso = current_utc_iso8601();
        fp_json::Value rt = fp_json::Value::make_object();

        fp_json::Value gw_obj = fp_json::Value::make_object();
        if (active_gw_pid != 0) gw_obj.set("pid", fp_json::Value::make_int(active_gw_pid));
        else gw_obj.set("pid", fp_json::Value::make_null());
        gw_obj.set("port", fp_json::Value::make_int(cfg.gateway_port));
        gw_obj.set("executable", fp_json::Value::make_string(path_to_utf8(gw_exe)));
        std::string gw_start = get_process_start_iso8601(active_gw_pid);
        gw_obj.set("startTime", gw_start.empty() ? fp_json::Value::make_null() : fp_json::Value::make_string(gw_start));
        gw_obj.set("updatedAt", fp_json::Value::make_string(now_iso));

        fp_json::Value web_obj = fp_json::Value::make_object();
        if (active_web_pid != 0) web_obj.set("pid", fp_json::Value::make_int(active_web_pid));
        else web_obj.set("pid", fp_json::Value::make_null());
        web_obj.set("port", fp_json::Value::make_int(cfg.web_port));
        web_obj.set("script", fp_json::Value::make_string(path_to_utf8(server_script)));
        std::string web_start = get_process_start_iso8601(active_web_pid);
        web_obj.set("startTime", web_start.empty() ? fp_json::Value::make_null() : fp_json::Value::make_string(web_start));
        web_obj.set("updatedAt", fp_json::Value::make_string(now_iso));

        rt.set("gateway", std::move(gw_obj));
        rt.set("webServer", std::move(web_obj));
        write_file_utf8(proc_json, fp_json::dump(rt, 2));
    }

    // -------------------------------------------------------------------------
    // 4. Launch Browser According to Resolved Configuration
    // -------------------------------------------------------------------------
    if (effective_launch_mode == "none") {
        out.println("ブラウザの自動起動をスキップしました (mode: none)。URL: " + browser_url);
    } else if (effective_launch_mode == "browser" && resolved_browser_exe) {
        std::wstring cmdline = quote_windows_arg(resolved_browser_exe->wstring());
        for (const auto& a : final_browser_args) {
            cmdline += L" " + quote_windows_arg(to_wide(a));
        }
        STARTUPINFOW bsi = {};
        bsi.cb = sizeof(bsi);
        PROCESS_INFORMATION bpi = {};
        std::wstring wexe = resolved_browser_exe->wstring();
        if (CreateProcessW(wexe.c_str(), cmdline.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &bsi, &bpi)) {
            CloseHandle(bpi.hThread);
            CloseHandle(bpi.hProcess);
            out.println("[OK] ブラウザを起動しました (" + path_to_utf8(resolved_browser_exe->filename()) + "): " + browser_url);
        } else {
            std::wstring wurl = to_wide(browser_url);
            ShellExecuteW(nullptr, L"open", wurl.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        }
    } else {
        std::wstring wurl = to_wide(browser_url);
        ShellExecuteW(nullptr, L"open", wurl.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        out.println("[OK] システム既定のブラウザで開きました: " + browser_url);
    }

    WSACleanup();
    return 0;
}
