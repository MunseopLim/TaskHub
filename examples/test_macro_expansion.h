// Test file for macro expansion hover feature

#define BIT0 (1 << 0)
#define BIT1 (1 << 1)
#define BIT5 (1 << 5)
#define UART_TX_EN 0x40

// Simple macro
#define MAX_SIZE 0x1000

// Compound macro (references other macros)
#define IRQ_ENABLE (BIT0 | BIT5 | UART_TX_EN)

// Nested macro
#define BASE_ADDR 0x40000000
#define REG_OFFSET 0x1000
#define UART_CTRL (BASE_ADDR + REG_OFFSET)

// Multi-level nesting
#define LEVEL1 0x01
#define LEVEL2 LEVEL1
#define LEVEL3 LEVEL2
#define LEVEL4 LEVEL3

// Complex expression
#define MASK_LOW 0xFF
#define MASK_HIGH 0xFF00
#define FULL_MASK (MASK_LOW | MASK_HIGH)

// Binary value
#define FLAGS 0b11110000

// Decimal value
#define COUNT 255

void test_macros() {
    // Hover over these macros to see expansion:
    int a = MAX_SIZE;        // Should show: 0x1000
    int b = IRQ_ENABLE;      // Should show: (1 << 0) | (1 << 5) | 0x40 = 0x61
    int c = UART_CTRL;       // Should show: 0x40001000
    int d = LEVEL4;          // Should show multi-level expansion
    int e = FULL_MASK;       // Should show: 0xFFFF
    int f = FLAGS;           // Should show: 0b11110000 = 0xF0 = 240
    int g = COUNT;           // Should show: 255 = 0xFF
}
