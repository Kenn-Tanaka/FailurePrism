#pragma once

#include <cctype>
#include <cstdint>
#include <cmath>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace fp_json {

enum class Type { Null, Bool, Number, String, Array, Object };

struct Value {
    Type type = Type::Null;
    bool bool_val = false;
    double num_val = 0.0;
    std::string str_val;
    std::vector<Value> arr_val;
    std::vector<std::pair<std::string, Value>> obj_val;

    static Value make_null() { return Value{}; }
    static Value make_bool(bool b) {
        Value v;
        v.type = Type::Bool;
        v.bool_val = b;
        return v;
    }
    static Value make_number(double n) {
        Value v;
        v.type = Type::Number;
        v.num_val = n;
        return v;
    }
    static Value make_int(int64_t n) {
        return make_number(static_cast<double>(n));
    }
    static Value make_string(std::string s) {
        Value v;
        v.type = Type::String;
        v.str_val = std::move(s);
        return v;
    }
    static Value make_array(std::vector<Value> a = {}) {
        Value v;
        v.type = Type::Array;
        v.arr_val = std::move(a);
        return v;
    }
    static Value make_object() {
        Value v;
        v.type = Type::Object;
        return v;
    }

    bool is_null() const noexcept { return type == Type::Null; }
    bool is_bool() const noexcept { return type == Type::Bool; }
    bool is_number() const noexcept { return type == Type::Number; }
    bool is_string() const noexcept { return type == Type::String; }
    bool is_array() const noexcept { return type == Type::Array; }
    bool is_object() const noexcept { return type == Type::Object; }

    const Value* find(const std::string& key) const noexcept {
        if (type != Type::Object) return nullptr;
        for (const auto& kv : obj_val) {
            if (kv.first == key) return &kv.second;
        }
        return nullptr;
    }

    Value* find_mut(const std::string& key) noexcept {
        if (type != Type::Object) return nullptr;
        for (auto& kv : obj_val) {
            if (kv.first == key) return &kv.second;
        }
        return nullptr;
    }

    void set(const std::string& key, Value val) {
        if (type != Type::Object) {
            type = Type::Object;
            obj_val.clear();
        }
        for (auto& kv : obj_val) {
            if (kv.first == key) {
                kv.second = std::move(val);
                return;
            }
        }
        obj_val.emplace_back(key, std::move(val));
    }

    std::string get_string(const std::string& key, const std::string& fallback = "") const {
        const Value* v = find(key);
        return (v && v->is_string()) ? v->str_val : fallback;
    }

    bool get_bool(const std::string& key, bool fallback = false) const {
        const Value* v = find(key);
        return (v && v->is_bool()) ? v->bool_val : fallback;
    }

    int64_t get_int(const std::string& key, int64_t fallback = 0) const {
        const Value* v = find(key);
        return (v && v->is_number()) ? static_cast<int64_t>(std::llround(v->num_val)) : fallback;
    }
};

class Parser {
public:
    explicit Parser(const std::string& input) : s_(input), pos_(0) {
        // Strip UTF-8 BOM if present
        if (s_.size() >= 3 &&
            static_cast<unsigned char>(s_[0]) == 0xEF &&
            static_cast<unsigned char>(s_[1]) == 0xBB &&
            static_cast<unsigned char>(s_[2]) == 0xBF) {
            pos_ = 3;
        }
    }

    Value parse() {
        skip_ws_and_comments();
        Value v = parse_value();
        skip_ws_and_comments();
        if (pos_ != s_.size()) {
            throw std::runtime_error("Unexpected trailing characters in JSON");
        }
        return v;
    }

private:
    const std::string& s_;
    size_t pos_;

    void skip_ws_and_comments() {
        while (pos_ < s_.size()) {
            unsigned char c = static_cast<unsigned char>(s_[pos_]);
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
                ++pos_;
                continue;
            }
            // Allow // and /* */ JSONC comments in hand-edited config files
            if (c == '/' && pos_ + 1 < s_.size()) {
                if (s_[pos_ + 1] == '/') {
                    pos_ += 2;
                    while (pos_ < s_.size() && s_[pos_] != '\n') ++pos_;
                    continue;
                }
                if (s_[pos_ + 1] == '*') {
                    pos_ += 2;
                    while (pos_ + 1 < s_.size() && !(s_[pos_] == '*' && s_[pos_ + 1] == '/')) ++pos_;
                    if (pos_ + 1 < s_.size()) pos_ += 2;
                    continue;
                }
            }
            break;
        }
    }

    char peek() const {
        if (pos_ >= s_.size()) throw std::runtime_error("Unexpected end of JSON");
        return s_[pos_];
    }

    char get() {
        char c = peek();
        ++pos_;
        return c;
    }

    static void append_utf8(std::string& out, uint32_t cp) {
        if (cp <= 0x7F) {
            out.push_back(static_cast<char>(cp));
        } else if (cp <= 0x7FF) {
            out.push_back(static_cast<char>(0xC0 | ((cp >> 6) & 0x1F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp <= 0xFFFF) {
            out.push_back(static_cast<char>(0xE0 | ((cp >> 12) & 0x0F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | ((cp >> 18) & 0x07)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }

    uint16_t parse_hex4() {
        if (pos_ + 4 > s_.size()) throw std::runtime_error("Invalid unicode escape");
        uint16_t val = 0;
        for (int i = 0; i < 4; ++i) {
            char c = s_[pos_++];
            val <<= 4;
            if (c >= '0' && c <= '9') val |= static_cast<uint16_t>(c - '0');
            else if (c >= 'a' && c <= 'f') val |= static_cast<uint16_t>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') val |= static_cast<uint16_t>(c - 'A' + 10);
            else throw std::runtime_error("Invalid hex digit in unicode escape");
        }
        return val;
    }

    std::string parse_string() {
        if (get() != '"') throw std::runtime_error("Expected '\"'");
        std::string out;
        while (pos_ < s_.size()) {
            char c = get();
            if (c == '"') return out;
            if (c == '\\') {
                char esc = get();
                switch (esc) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': {
                        uint16_t u1 = parse_hex4();
                        if (u1 >= 0xD800 && u1 <= 0xDBFF && pos_ + 2 <= s_.size() &&
                            s_[pos_] == '\\' && s_[pos_ + 1] == 'u') {
                            pos_ += 2;
                            uint16_t u2 = parse_hex4();
                            uint32_t cp = 0x10000 + ((static_cast<uint32_t>(u1 - 0xD800) << 10) |
                                                     static_cast<uint32_t>(u2 - 0xDC00));
                            append_utf8(out, cp);
                        } else {
                            append_utf8(out, u1);
                        }
                        break;
                    }
                    default:
                        out.push_back(esc);
                        break;
                }
            } else {
                out.push_back(c);
            }
        }
        throw std::runtime_error("Unterminated string in JSON");
    }

    Value parse_number() {
        size_t start = pos_;
        if (s_[pos_] == '-') ++pos_;
        while (pos_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[pos_]))) ++pos_;
        if (pos_ < s_.size() && s_[pos_] == '.') {
            ++pos_;
            while (pos_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[pos_]))) ++pos_;
        }
        if (pos_ < s_.size() && (s_[pos_] == 'e' || s_[pos_] == 'E')) {
            ++pos_;
            if (pos_ < s_.size() && (s_[pos_] == '+' || s_[pos_] == '-')) ++pos_;
            while (pos_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[pos_]))) ++pos_;
        }
        double val = std::stod(s_.substr(start, pos_ - start));
        return Value::make_number(val);
    }

    Value parse_array() {
        get(); // '['
        Value arr = Value::make_array();
        skip_ws_and_comments();
        if (peek() == ']') {
            get();
            return arr;
        }
        while (true) {
            skip_ws_and_comments();
            arr.arr_val.push_back(parse_value());
            skip_ws_and_comments();
            char c = get();
            if (c == ']') break;
            if (c != ',') throw std::runtime_error("Expected ',' or ']' in array");
            // Tolerate trailing comma
            skip_ws_and_comments();
            if (peek() == ']') {
                get();
                break;
            }
        }
        return arr;
    }

    Value parse_object() {
        get(); // '{'
        Value obj = Value::make_object();
        skip_ws_and_comments();
        if (peek() == '}') {
            get();
            return obj;
        }
        while (true) {
            skip_ws_and_comments();
            std::string key = parse_string();
            skip_ws_and_comments();
            if (get() != ':') throw std::runtime_error("Expected ':' in object");
            skip_ws_and_comments();
            Value val = parse_value();
            obj.set(key, std::move(val));
            skip_ws_and_comments();
            char c = get();
            if (c == '}') break;
            if (c != ',') throw std::runtime_error("Expected ',' or '}' in object");
            // Tolerate trailing comma
            skip_ws_and_comments();
            if (peek() == '}') {
                get();
                break;
            }
        }
        return obj;
    }

    Value parse_value() {
        skip_ws_and_comments();
        char c = peek();
        if (c == '"') return Value::make_string(parse_string());
        if (c == '{') return parse_object();
        if (c == '[') return parse_array();
        if (c == '-' || std::isdigit(static_cast<unsigned char>(c))) return parse_number();
        if (s_.compare(pos_, 4, "true") == 0) {
            pos_ += 4;
            return Value::make_bool(true);
        }
        if (s_.compare(pos_, 5, "false") == 0) {
            pos_ += 5;
            return Value::make_bool(false);
        }
        if (s_.compare(pos_, 4, "null") == 0) {
            pos_ += 4;
            return Value::make_null();
        }
        throw std::runtime_error("Invalid JSON value");
    }
};

inline Value parse(const std::string& text) {
    return Parser(text).parse();
}

inline void escape_string_into(std::ostringstream& os, const std::string& s) {
    os << '"';
    for (unsigned char c : s) {
        switch (c) {
            case '"': os << "\\\""; break;
            case '\\': os << "\\\\"; break;
            case '\b': os << "\\b"; break;
            case '\f': os << "\\f"; break;
            case '\n': os << "\\n"; break;
            case '\r': os << "\\r"; break;
            case '\t': os << "\\t"; break;
            default:
                if (c < 0x20) {
                    const char* hex = "0123456789abcdef";
                    os << "\\u00" << hex[(c >> 4) & 0xF] << hex[c & 0xF];
                } else {
                    os << static_cast<char>(c);
                }
                break;
        }
    }
    os << '"';
}

inline void dump_into(std::ostringstream& os, const Value& v, int indent, int depth) {
    const std::string pad(indent > 0 ? static_cast<size_t>(indent * depth) : 0, ' ');
    const std::string child_pad(indent > 0 ? static_cast<size_t>(indent * (depth + 1)) : 0, ' ');
    switch (v.type) {
        case Type::Null:
            os << "null";
            break;
        case Type::Bool:
            os << (v.bool_val ? "true" : "false");
            break;
        case Type::Number: {
            double intpart = 0.0;
            if (std::isfinite(v.num_val) && std::modf(v.num_val, &intpart) == 0.0 &&
                v.num_val >= -9007199254740992.0 && v.num_val <= 9007199254740992.0) {
                os << static_cast<int64_t>(intpart);
            } else {
                os << v.num_val;
            }
            break;
        }
        case Type::String:
            escape_string_into(os, v.str_val);
            break;
        case Type::Array:
            if (v.arr_val.empty()) {
                os << "[]";
                break;
            }
            os << (indent > 0 ? "[\n" : "[");
            for (size_t i = 0; i < v.arr_val.size(); ++i) {
                if (indent > 0) os << child_pad;
                dump_into(os, v.arr_val[i], indent, depth + 1);
                if (i + 1 < v.arr_val.size()) os << ",";
                if (indent > 0) os << "\n";
            }
            if (indent > 0) os << pad;
            os << "]";
            break;
        case Type::Object:
            if (v.obj_val.empty()) {
                os << "{}";
                break;
            }
            os << (indent > 0 ? "{\n" : "{");
            for (size_t i = 0; i < v.obj_val.size(); ++i) {
                if (indent > 0) os << child_pad;
                escape_string_into(os, v.obj_val[i].first);
                os << (indent > 0 ? ": " : ":");
                dump_into(os, v.obj_val[i].second, indent, depth + 1);
                if (i + 1 < v.obj_val.size()) os << ",";
                if (indent > 0) os << "\n";
            }
            if (indent > 0) os << pad;
            os << "}";
            break;
    }
}

inline std::string dump(const Value& v, int indent = 2) {
    std::ostringstream os;
    dump_into(os, v, indent, 0);
    if (indent > 0) os << "\n";
    return os.str();
}

} // namespace fp_json
