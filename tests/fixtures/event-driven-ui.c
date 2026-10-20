#include <stdint.h>

#define INPUT_CAPACITY 65536
#define UI_CAPACITY 16384

static char input_buffer[INPUT_CAPACITY];
static char ui_buffer[UI_CAPACITY];
static int ui_length;
static int selected_card;
static int hovered_card;
static int confirmed;
static int complete;

static const char *card_ids[] = {"ace-spades", "king-hearts", "queen-diamonds"};
static int result_length;
static char result_buffer[128];

static int append(const char *text) {
    while (*text) {
        if (ui_length >= UI_CAPACITY) return 0;
        ui_buffer[ui_length++] = *text++;
    }
    return 1;
}

static int append_card(int index) {
    const char *prefixes[] = {
        "{\"type\":\"button\",\"id\":\"spades\",\"label\":\"Ace of Spades\",\"selected\":",
        "{\"type\":\"button\",\"id\":\"hearts\",\"label\":\"King of Hearts\",\"selected\":",
        "{\"type\":\"button\",\"id\":\"diamonds\",\"label\":\"Queen of Diamonds\",\"selected\":"
    };
    const char *ranks[] = {"A", "K", "Q"};
    const char *suits[] = {"\xe2\x99\xa0", "\xe2\x99\xa5", "\xe2\x99\xa6"};
    const char *colors[] = {"#24334d", "#c93345", "#c93345"};

    if (!append(prefixes[index]) || !append(selected_card == index + 1 ? "true" : "false") ||
        !append(",\"hover\":true,\"children\":[{\"type\":\"svg\",\"viewBox\":\"0 0 100 140\",\"width\":100,\"height\":140,\"children\":[{\"type\":\"rect\",\"x\":2,\"y\":2,\"width\":96,\"height\":136,\"rx\":8,\"fill\":\"#fffdf8\",\"stroke\":\"") ||
        !append(hovered_card == index + 1 ? "#435ff0" : "#aab2c0") ||
        !append("\",\"strokeWidth\":") ||
        !append(hovered_card == index + 1 ? "3" : "1.5") ||
        !append("},{\"type\":\"svgText\",\"x\":50,\"y\":64,\"fontSize\":48,\"fill\":\"") ||
        !append(colors[index]) || !append("\",\"anchor\":\"middle\",\"value\":\"") ||
        !append(ranks[index]) || !append("\"},{\"type\":\"svgText\",\"x\":50,\"y\":112,\"fontSize\":38,\"fill\":\"") ||
        !append(colors[index]) || !append("\",\"anchor\":\"middle\",\"value\":\"") ||
        !append(suits[index]) || !append("\"}]}]}")) return 0;
    return 1;
}

static int build_ui(void) {
    ui_length = 0;
    if (!append("{\"version\":1,\"title\":\"WASM contract fixture\",\"root\":{\"type\":\"column\",\"children\":[{\"type\":\"text\",\"value\":\"Select one card, confirm, and submit to exercise the event-driven ABI.\"},{\"type\":\"row\",\"children\":[")) return 0;
    if (!append_card(0) || !append(",") || !append_card(1) || !append(",") || !append_card(2)) return 0;
    if (!append("]},{\"type\":\"checkbox\",\"id\":\"confirm\",\"label\":\"I confirm this selection\",\"checked\":") ||
        !append(confirmed ? "true" : "false") ||
        !append("},{\"type\":\"button\",\"id\":\"submit\",\"label\":\"Submit selection\",\"disabled\":") ||
        !append(selected_card != 0 && confirmed ? "false" : "true") ||
        !append(",\"children\":[]}]}}")) return 0;
    return 1;
}

static int contains(const char *text, const char *needle, int length) {
    for (int i = 0; i <= length; i++) {
        int j = 0;
        while (needle[j] && i + j < length && text[i + j] == needle[j]) j++;
        if (!needle[j]) return 1;
    }
    return 0;
}

static void build_result(void) {
    static const char prefix[] = "{\"selectedCard\":\"";
    static const char suffix[] = "\"}";
    int output = 0;
    for (int i = 0; i < (int)(sizeof(prefix) - 1); i++) result_buffer[output++] = prefix[i];
    const char *id = card_ids[selected_card - 1];
    while (*id) result_buffer[output++] = *id++;
    for (int i = 0; i < (int)(sizeof(suffix) - 1); i++) result_buffer[output++] = suffix[i];
    result_length = output;
}

int alloc(int length) {
    if (length < 0 || length > INPUT_CAPACITY) return 0;
    return (int)(uintptr_t)input_buffer;
}

int ui_ptr(void) {
    if (!build_ui()) return 0;
    return (int)(uintptr_t)ui_buffer;
}

int ui_len(void) {
    return ui_length;
}

void handle_event(int input_pointer, int input_length) {
    const char *input = (const char *)(uintptr_t)(uint32_t)input_pointer;
    if (input != input_buffer || input_length < 0 || input_length > INPUT_CAPACITY) return;

    if (!contains(input, "\"type\":\"click\"", input_length) &&
        !contains(input, "\"type\":\"change\"", input_length) &&
        !contains(input, "\"type\":\"pointerenter\"", input_length) &&
        !contains(input, "\"type\":\"pointerleave\"", input_length)) return;

    if (contains(input, "\"type\":\"pointerenter\"", input_length) &&
        contains(input, "\"target\":\"spades\"", input_length)) {
        hovered_card = 1;
    } else if (contains(input, "\"type\":\"pointerenter\"", input_length) &&
               contains(input, "\"target\":\"hearts\"", input_length)) {
        hovered_card = 2;
    } else if (contains(input, "\"type\":\"pointerenter\"", input_length) &&
               contains(input, "\"target\":\"diamonds\"", input_length)) {
        hovered_card = 3;
    } else if (contains(input, "\"type\":\"pointerleave\"", input_length) &&
               contains(input, "\"target\":\"spades\"", input_length) && hovered_card == 1) {
        hovered_card = 0;
    } else if (contains(input, "\"type\":\"pointerleave\"", input_length) &&
               contains(input, "\"target\":\"hearts\"", input_length) && hovered_card == 2) {
        hovered_card = 0;
    } else if (contains(input, "\"type\":\"pointerleave\"", input_length) &&
               contains(input, "\"target\":\"diamonds\"", input_length) && hovered_card == 3) {
        hovered_card = 0;
    } else if (contains(input, "\"type\":\"click\"", input_length) &&
        contains(input, "\"target\":\"spades\"", input_length)) {
        selected_card = 1;
        confirmed = 0;
    } else if (contains(input, "\"type\":\"click\"", input_length) &&
               contains(input, "\"target\":\"hearts\"", input_length)) {
        selected_card = 2;
        confirmed = 0;
    } else if (contains(input, "\"type\":\"click\"", input_length) &&
               contains(input, "\"target\":\"diamonds\"", input_length)) {
        selected_card = 3;
        confirmed = 0;
    } else if (contains(input, "\"type\":\"change\"", input_length) &&
               contains(input, "\"target\":\"confirm\"", input_length)) {
        confirmed = contains(input, "\"checked\":true", input_length);
    } else if (contains(input, "\"type\":\"click\"", input_length) &&
               contains(input, "\"target\":\"submit\"", input_length) && selected_card && confirmed) {
        complete = 1;
        build_result();
    }
}

int is_complete(void) {
    return complete;
}

int result_ptr(void) {
    return (int)(uintptr_t)result_buffer;
}

int result_len(void) {
    return result_length;
}
