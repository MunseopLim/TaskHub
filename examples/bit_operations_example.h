/**
 * @file bit_operations_example.h
 * @brief Example file for testing Bit Operation Hover feature
 *
 * SETUP:
 * Enable: taskhub.experimental.bitOperationHover.enabled = true
 *
 * SUPPORTED PATTERNS (hover to see results):
 * ✅ Variable & Literal: value |= 0x80, value & 0xFF
 * ✅ Constant expressions: (1U << 5), 0xFF & 0x0F
 * ✅ NOT operation: ~value
 *
 * NOT SUPPORTED:
 * ❌ Variable & Variable: a ^ b (use constant instead: 0x55 ^ 0x53)
 * ❌ Function calls: value &= func()
 * ❌ Complex expressions: value &= (1 << bit) (but you can hover on (1 << bit) part)
 */

#ifndef BIT_OPERATIONS_EXAMPLE_H
#define BIT_OPERATIONS_EXAMPLE_H

#include <stdint.h>

// ============================================================================
// Register Definitions (typical embedded style)
// ============================================================================

#define REG_CTRL_BASE       0x40000000UL

// Control Register Bits
// TIP: Hover over << in these constant expressions to see calculated values!
#define CTRL_ENABLE         (1U << 0)   // Bit 0: Enable - Hover shows: 1 << 0 = 0x1
#define CTRL_READY          (1U << 1)   // Bit 1: Ready - Hover shows: 1 << 1 = 0x2
#define CTRL_IRQ_EN         (1U << 2)   // Bit 2: Interrupt Enable - Hover shows: 1 << 2 = 0x4
#define CTRL_MODE_MASK      (3U << 3)   // Bits [4:3]: Mode Select - Hover shows: 3 << 3 = 0x18
#define CTRL_PRIORITY_MASK  (7U << 5)   // Bits [7:5]: Priority Level - Hover shows: 7 << 5 = 0xE0

// Status Register Bits
#define STATUS_BUSY         (1U << 0)   // Hover: 1 << 0 = 0x1
#define STATUS_ERROR        (1U << 1)   // Hover: 1 << 1 = 0x2
#define STATUS_COMPLETE     (1U << 2)   // Hover: 1 << 2 = 0x4

// ============================================================================
// Constant Expression Examples (NEW FEATURE!)
// ============================================================================
// Hover over the operators in these constant expressions to see calculated results

// Shift operations with different values
#define BIT_0               1U << 0      // Hover over <<: shows 1 -> 0x1
#define BIT_5               1U << 5      // Hover over <<: shows 1 -> 0x20 (32)
#define BIT_12              1UL << 12    // Hover over <<: shows 1 -> 0x1000 (4096)
#define BIT_16              1UL << 16    // Hover over <<: shows 1 -> 0x10000 (65536)
#define BIT_31              1UL << 31    // Hover over <<: shows 1 -> 0x80000000

// Multi-bit masks
#define MASK_2BITS          3U << 0      // Hover over <<: shows 3 -> 0x3
#define MASK_4BITS          0xF << 4     // Hover over <<: shows 15 -> 0xF0
#define MASK_BYTE           0xFF << 8    // Hover over <<: shows 255 -> 0xFF00

// Bitwise AND examples
#define LOW_NIBBLE          0xFF & 0x0F  // Hover over &: shows 0xFF -> 0x0F
#define EVEN_BITS           0xFF & 0xAA  // Hover over &: shows 0xFF -> 0xAA

// Bitwise OR examples
#define COMBINED_FLAGS      0x01 | 0x04  // Hover over |: shows 0x01 -> 0x05
#define RGB_RED_GREEN       0xFF | 0xFF00 // Hover over |: shows 0xFF -> 0xFFFF

// Bitwise XOR examples
#define TOGGLE_PATTERN      0xAA ^ 0x55  // Hover over ^: shows 0xAA -> 0xFF
#define INVERT_BYTE         0xFF ^ 0x00  // Hover over ^: shows 0xFF -> 0xFF

// Right shift examples
#define DIV_BY_2            256 >> 1     // Hover over >>: shows 256 -> 128
#define DIV_BY_16           1024 >> 4    // Hover over >>: shows 1024 -> 64

// ============================================================================
// Example 1: Setting and Clearing Register Bits
// ============================================================================

void example_set_clear_bits(void)
{
    uint32_t ctrl_reg = 0x00;

    // Set ENABLE bit - Hover over |= to see: 0x00 -> 0x01
    ctrl_reg |= CTRL_ENABLE;

    // Set IRQ_EN bit - Hover over |= to see: 0x01 -> 0x05
    ctrl_reg |= CTRL_IRQ_EN;

    // Clear ENABLE bit - Hover over &= to see: 0x05 -> 0x04
    ctrl_reg &= ~CTRL_ENABLE;

    // Toggle READY bit - Hover over ^= to see bit flip
    ctrl_reg ^= CTRL_READY;
}

// ============================================================================
// Example 2: Bit Masking Operations
// ============================================================================

void example_bit_masking(void)
{
    uint32_t value = 0xABCD1234;

    // Extract lower byte - Hover over &= to see: 0xABCD1234 -> 0x00000034
    uint32_t lower_byte = value;
    lower_byte &= 0xFF;

    // Extract upper nibble - Hover over & to see extraction
    uint32_t upper_nibble = (value >> 28) & 0xF;

    // Clear specific bits - Hover over &= to see bits cleared
    uint32_t masked = value;
    masked &= ~0x0000FF00;  // Clear bits [15:8]
}

// ============================================================================
// Example 3: Bit Shifting Operations
// ============================================================================

void example_bit_shifting(void)
{
    uint32_t data = 0x01;

    // Left shift - Hover over <<= to see: 0x01 -> 0x10
    data <<= 4;

    // Right shift - Hover over >>= to see: 0x10 -> 0x01
    data >>= 4;

    // Create bit mask by shifting - Hover over << to see result
    uint32_t bit_mask = 1U << 7;  // Create bit 7 mask
}

// ============================================================================
// Example 4: Flag Management
// ============================================================================

typedef enum {
    FLAG_NONE       = 0x00,
    FLAG_INIT       = 0x01,
    FLAG_RUNNING    = 0x02,
    FLAG_PAUSED     = 0x04,
    FLAG_ERROR      = 0x08,
    FLAG_COMPLETE   = 0x10
} system_flags_t;

void example_flag_management(void)
{
    uint8_t flags = FLAG_NONE;

    // Set initialization flag - Hover over |= to see: 0x00 -> 0x01
    flags |= FLAG_INIT;

    // Set running flag - Hover over |= to see: 0x01 -> 0x03
    flags |= FLAG_RUNNING;

    // Clear init, set complete - Hover over operations to see changes
    flags &= ~FLAG_INIT;      // Clear init: 0x03 -> 0x02
    flags |= FLAG_COMPLETE;   // Set complete: 0x02 -> 0x12

    // Check if any error or running - Hover over & to see result
    uint8_t is_active = flags & (FLAG_RUNNING | FLAG_ERROR);
}

// ============================================================================
// Example 5: Field Manipulation (Mode and Priority)
// ============================================================================

void example_field_manipulation(void)
{
    uint32_t ctrl_reg = 0x00;

    // Set mode to 2 (binary 10) - Hover over |= to see field update
    ctrl_reg |= (2U << 3);  // Mode field is at bits [4:3]

    // Set priority to 5 (binary 101) - Hover over |= to see field update
    ctrl_reg |= (5U << 5);  // Priority field is at bits [7:5]

    // Clear mode field - Hover over &= to see field cleared
    ctrl_reg &= ~CTRL_MODE_MASK;

    // Update priority to 7 - Hover over each operation
    ctrl_reg &= ~CTRL_PRIORITY_MASK;  // Clear priority field
    ctrl_reg |= (7U << 5);             // Set new priority
}

// ============================================================================
// Example 6: Bitwise NOT and XOR Operations
// ============================================================================

void example_not_and_xor(void)
{
    uint8_t value = 0xF0;

    // Bitwise NOT - Hover over ~ to see: 0xF0 -> 0x0F (in 8-bit context)
    uint8_t inverted = ~value;

    // XOR for toggling - Hover over ^= to see bits flip
    uint8_t toggle = 0xAA;
    toggle ^= 0x0F;  // Toggle lower nibble

    // XOR for comparison
    uint8_t a = 0x55;
    uint8_t b = 0x53;

    // ❌ NOT SUPPORTED: Variable XOR Variable
    // uint8_t diff = a ^ b;  // This pattern is NOT supported

    // ✅ SUPPORTED: Use constant XOR instead
    uint8_t diff = 0x55 ^ 0x53;  // Hover over ^ to see: 0x55 -> 0x06
}

// ============================================================================
// Example 7: Real-World UART Control Register
// ============================================================================

#define UART_CR_ENABLE      (1U << 0)   // UART Enable
#define UART_CR_TXEN        (1U << 3)   // Transmitter Enable
#define UART_CR_RXEN        (1U << 4)   // Receiver Enable
#define UART_CR_PARITY_EN   (1U << 8)   // Parity Enable
#define UART_CR_PARITY_ODD  (1U << 9)   // 0=Even, 1=Odd
#define UART_CR_STOP_2BIT   (1U << 12)  // 0=1 stop bit, 1=2 stop bits

void example_uart_init(void)
{
    volatile uint32_t *uart_cr = (uint32_t *)0x40010000;

    // Initialize: Enable UART, TX, RX with even parity
    *uart_cr = 0x00;

    // Hover over each |= to see register being configured step by step
    *uart_cr |= UART_CR_ENABLE;     // Enable UART
    *uart_cr |= UART_CR_TXEN;       // Enable TX
    *uart_cr |= UART_CR_RXEN;       // Enable RX
    *uart_cr |= UART_CR_PARITY_EN;  // Enable parity (even by default)
}

// ============================================================================
// Example 8: Complex Bit Manipulations
// ============================================================================

void example_complex_operations(void)
{
    uint32_t config = 0x12345678;

    // Extract and modify specific bit range
    // Hover over each operation to see the transformation
    uint32_t temp = config & 0x00FF0000;  // Extract bits [23:16]
    temp >>= 16;                          // Shift to position 0
    temp |= 0x80;                         // Set bit 7
    temp <<= 16;                          // Shift back
    config &= ~0x00FF0000;                // Clear original field
    config |= temp;                       // Insert modified value

    // Swap nibbles in a byte
    uint8_t byte = 0xA5;
    uint8_t swapped = ((byte & 0x0F) << 4) | ((byte & 0xF0) >> 4);
}

#endif // BIT_OPERATIONS_EXAMPLE_H
