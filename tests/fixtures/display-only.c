#include <stdint.h>

static const char ui_tree[] =
    "{\"version\":1,\"title\":\"Static WASM UI\",\"root\":{\"type\":\"column\","
    "\"children\":[{\"type\":\"text\",\"value\":\"This fixture only displays content.\"}]}}";

int ui_ptr(void) {
    return (int)(uintptr_t)ui_tree;
}

int ui_len(void) {
    return (int)(sizeof(ui_tree) - 1);
}
