// Phase 2 test file: const, enum, and identifier support

// Test const variables
const int MASK_VALUE = 0xFF;
const int BIT_FLAG = 0b10101010;
const int DECIMAL_CONST = 255;

// Test enum
enum StatusFlags {
    FLAG_READY = 0x01,
    FLAG_BUSY = 0x02,
    FLAG_ERROR = 0x04,
    FLAG_COMPLETE = 0x08
};

// Test #define
#define MAX_SIZE 0x1000
#define BIT_MASK 0b11110000

int main() {
    // Hovering over these identifiers should show their values
    int value1 = MASK_VALUE;        // Should show 0xFF = 255
    int value2 = BIT_FLAG;          // Should show 0b10101010
    int value3 = DECIMAL_CONST;     // Should show 255

    StatusFlags status = FLAG_READY;  // Should show 0x01

    if (status == FLAG_ERROR) {     // Should show 0x04
        // error handling
    }

    int size = MAX_SIZE;            // Should show 0x1000
    int mask = BIT_MASK;            // Should show 0b11110000

    return 0;
}
