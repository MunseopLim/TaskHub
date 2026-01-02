/**
 * @file bit_operations_example.cpp
 * @brief Practical examples with actual values for Bit Operation Hover testing
 *
 * This file contains examples with concrete values so you can see
 * the before/after results when hovering over bit operations.
 *
 * SETUP:
 * Enable: taskhub.experimental.bitOperationHover.enabled = true
 *
 * SUPPORTED PATTERNS (hover to see results):
 * ✅ Variable & Literal: value |= 0x80, value & 0xFF
 *    - Shows Before/After if variable value is known
 * ✅ Constant expressions: (1U << 5), 0xFF & 0x0F
 *    - Always shows Left/Result
 *
 * NOT SUPPORTED:
 * ❌ Variable & Variable: a ^ b
 * ❌ Function calls: value &= sensor_read()
 * ❌ Complex expressions in operand position
 */

#include <stdint.h>
#include <stdio.h>

// ============================================================================
// Constant Expression Examples (NEW FEATURE!)
// ============================================================================
// Hover over operators in these constant expressions to see calculated results

void constant_expression_demo(void)
{
    // Left shift constants - Hover over << to see results
    uint32_t bit5  = 1U << 5;       // Hover << : 1 -> 0x20 (32)
    uint32_t bit12 = 1UL << 12;     // Hover << : 1 -> 0x1000 (4096)
    uint32_t bit20 = 1UL << 20;     // Hover << : 1 -> 0x100000 (1048576)

    // Bitwise AND constants - Hover over & to see results
    uint32_t nibble = 0xFF & 0x0F;  // Hover & : 0xFF -> 0x0F
    uint32_t masked = 0x1234 & 0xFF00; // Hover & : 0x1234 -> 0x1200

    // Bitwise OR constants - Hover over | to see results
    uint32_t flags = 0x01 | 0x04;   // Hover | : 0x01 -> 0x05
    uint32_t combo = 0x80 | 0x40;   // Hover | : 0x80 -> 0xC0

    // Bitwise XOR constants - Hover over ^ to see results
    uint32_t toggle = 0xAA ^ 0x55;  // Hover ^ : 0xAA -> 0xFF
    uint32_t flip   = 0xFF ^ 0x0F;  // Hover ^ : 0xFF -> 0xF0

    // Right shift constants - Hover over >> to see results
    uint32_t half  = 256 >> 1;      // Hover >> : 256 -> 128
    uint32_t div16 = 1024 >> 4;     // Hover >> : 1024 -> 64

    // Multi-bit shifts - Hover over << to see multi-bit results
    uint32_t mask2 = 3U << 3;       // Hover << : 3 -> 0x18
    uint32_t mask4 = 0xF << 4;      // Hover << : 15 -> 0xF0
    uint32_t mask8 = 0xFF << 8;     // Hover << : 255 -> 0xFF00
}

// ============================================================================
// NOT SUPPORTED Patterns (for reference)
// ============================================================================
// These examples show patterns that are NOT supported by the hover feature

void unsupported_patterns_example(void)
{
    uint8_t a = 0xAA;
    uint8_t b = 0x55;

    // ❌ NOT SUPPORTED: Variable & Variable
    // uint8_t result = a ^ b;  // This will NOT show hover info

    // ✅ WORKAROUND: Use constant expression instead
    uint8_t result = 0xAA ^ 0x55;  // Hover ^ : 0xAA -> 0xFF

    // ❌ NOT SUPPORTED: Function call as operand
    // uint8_t value = 0xFF;
    // value &= get_mask();  // This will NOT show hover info

    // ✅ WORKAROUND: Use literal value
    uint8_t value = 0xFF;
    value &= 0x0F;  // Hover &= : shows Before/After

    // ❌ NOT SUPPORTED: Variable in complex expression
    // uint8_t shift = 5;
    // uint8_t mask = 1U << shift;  // Hover won't work on << here

    // ✅ SUPPORTED: But you CAN hover on constant shift expression
    uint8_t shift = 5;
    uint8_t temp = 1U << 5;     // Hover << : 1 -> 0x20
    // Then use the result
}

// ============================================================================
// Example 1: GPIO Pin Configuration (Common embedded scenario)
// ============================================================================

void configure_gpio_pin(void)
{
    // GPIO Port Control Register (initial value)
    uint32_t gpio_ctrl = 0x00000000;

    // Set pin 5 as output
    // - Hover over |= to see: 0x00000000 -> 0x00000020
    // - Hover over << in (1U << 5) to see constant: 1 -> 0x20
    gpio_ctrl |= (1U << 5);

    // Enable pull-up on pin 5
    // - Hover over |= to see: 0x00000020 -> 0x00002020
    // - Hover over << in (1U << 13) to see constant: 1 -> 0x2000
    gpio_ctrl |= (1U << 13);

    // Set pin mode to alternate function
    // Clear mode bits first - Hover over &= to see bits cleared
    // Also hover over << in (3U << 10) to see constant: 3 -> 0xC00
    gpio_ctrl &= ~(3U << 10);

    // Set mode to 0b10 (alternate function) - Hover over |= to see result
    // Also hover over << in (2U << 10) to see constant: 2 -> 0x800
    gpio_ctrl |= (2U << 10);
}

// ============================================================================
// Example 2: SPI Configuration Register
// ============================================================================

void configure_spi(void)
{
    // SPI Control Register 1
    uint32_t spi_cr1 = 0x00000000;

    // Configure SPI: Master mode, CPOL=1, CPHA=1, 8-bit, fPCLK/16
    // Hover over each |= to see register value build up

    spi_cr1 |= (1U << 2);   // Master mode: 0x00 -> 0x04
    spi_cr1 |= (1U << 0);   // CPHA=1: 0x04 -> 0x05
    spi_cr1 |= (1U << 1);   // CPOL=1: 0x05 -> 0x07
    spi_cr1 |= (3U << 3);   // BR=011 (fPCLK/16): 0x07 -> 0x1F

    // Disable SPI temporarily - Hover over &= to see: 0x1F -> 0x1D
    spi_cr1 &= ~(1U << 6);

    // Enable SPI - Hover over |= to see: 0x1D -> 0x5D
    spi_cr1 |= (1U << 6);
}

// ============================================================================
// Example 3: Timer Configuration
// ============================================================================

void configure_timer(void)
{
    uint32_t timer_cr = 0x00000000;

    // Enable timer - Hover to see: 0x00 -> 0x01
    timer_cr |= 0x01;

    // Set update request source - Hover to see: 0x01 -> 0x05
    timer_cr |= (1U << 2);

    // Set auto-reload preload - Hover to see: 0x05 -> 0x85
    timer_cr |= (1U << 7);

    // Configure edge-aligned mode (clear CMS bits) - Hover to see result
    timer_cr &= ~(3U << 5);
}

// ============================================================================
// Example 4: Interrupt Flag Handling
// ============================================================================

void handle_interrupt_flags(void)
{
    // Read interrupt status register (simulated value)
    uint32_t isr = 0x0000001F;  // Multiple flags set

    // Check specific flag - Hover over & to see: 0x1F & 0x01 = 0x01
    if (isr & 0x01) {
        // TX Complete flag is set
    }

    // Clear TX Complete flag - Hover over &= to see: 0x1F -> 0x1E
    isr &= ~0x01;

    // Clear multiple flags at once - Hover over &= to see: 0x1E -> 0x10
    isr &= ~(0x02 | 0x04 | 0x08);

    // Set error flag - Hover over |= to see: 0x10 -> 0x90
    isr |= (1U << 7);
}

// ============================================================================
// Example 5: Bit Field Extraction and Insertion
// ============================================================================

void bit_field_operations(void)
{
    uint32_t reg = 0x12345678;

    // Extract nibble at position 12-15 - Hover to see extraction
    uint32_t nibble = (reg >> 12) & 0xF;  // Result: 0x5

    // Extract byte at position 8-15 - Hover to see: 0x12345678 -> 0x56
    uint32_t byte_val = (reg >> 8) & 0xFF;

    // Modify a field: Change bits [11:8] to 0xA
    uint32_t temp = reg;
    temp &= ~(0xF << 8);    // Clear field - Hover to see bits cleared
    temp |= (0xA << 8);     // Insert new value - Hover to see insertion

    // Working with signed bit fields
    int32_t signed_val = 0xFFFFFFF0;  // -16 in two's complement
    signed_val >>= 4;                  // Arithmetic right shift - Hover to see
}

// ============================================================================
// Example 6: Power Management Register
// ============================================================================

void power_management(void)
{
    uint32_t pwr_cr = 0x00000000;

    // Enter low power mode configuration
    // Disable backup domain write protection - Hover: 0x00 -> 0x100
    pwr_cr |= (1U << 8);

    // Set voltage scaling - Hover to see field update
    pwr_cr |= (3U << 14);  // VOS = 11

    // Enable PVD (Programmable Voltage Detector) - Hover: see bit 4 set
    pwr_cr |= (1U << 4);

    // Set PVD level to 2.9V (PLS = 111) - Hover to see bits [7:5] change
    pwr_cr &= ~(7U << 5);   // Clear PLS field
    pwr_cr |= (7U << 5);    // Set PLS = 111
}

// ============================================================================
// Example 7: ADC Configuration
// ============================================================================

void configure_adc(void)
{
    uint32_t adc_cr = 0x00000000;

    // 12-bit resolution (RES = 00) - already default
    // Regular channel sequence length = 1 (L = 0000) - already default

    // Enable scan mode - Hover: 0x00 -> 0x100
    adc_cr |= (1U << 8);

    // Enable continuous conversion - Hover: 0x100 -> 0x102
    adc_cr |= (1U << 1);

    // Set external trigger (EXTEN = 01) - Hover to see bits [29:28] set
    adc_cr |= (1U << 28);

    // Select external trigger (EXTSEL = 0000 for Timer 1) - already default

    // Start conversion - Hover: see bit 30 set
    adc_cr |= (1U << 30);
}

// ============================================================================
// Example 8: DMA Stream Configuration
// ============================================================================

void configure_dma_stream(void)
{
    uint32_t dma_cr = 0x00000000;

    // Memory to peripheral - Hover: 0x00 -> 0x40
    dma_cr |= (1U << 6);

    // Circular mode - Hover: 0x40 -> 0x140
    dma_cr |= (1U << 8);

    // Memory increment mode - Hover: 0x140 -> 0x540
    dma_cr |= (1U << 10);

    // Peripheral size: 16-bit (PSIZE = 01) - Hover to see bits [12:11] set
    dma_cr |= (1U << 11);

    // Memory size: 16-bit (MSIZE = 01) - Hover to see bits [14:13] set
    dma_cr |= (1U << 13);

    // Priority: Very high (PL = 11) - Hover to see bits [17:16] set
    dma_cr |= (3U << 16);

    // Enable DMA stream - Hover: see bit 0 set
    dma_cr |= (1U << 0);
}

// ============================================================================
// Example 9: Real-world Flash Memory Control
// ============================================================================

void flash_memory_operation(void)
{
    volatile uint32_t flash_cr = 0x00000000;

    // Unlock flash for programming
    // (In real code, you'd write unlock keys to FLASH_KEYR first)

    // Set programming mode (PG bit) - Hover: 0x00 -> 0x01
    flash_cr |= (1U << 0);

    // Set parallelism to x32 (PSIZE = 10) - Hover to see bits [9:8] set
    flash_cr &= ~(3U << 8);     // Clear PSIZE field
    flash_cr |= (2U << 8);      // Set PSIZE = 10

    // After programming, wait for BSY flag to clear, then clear PG bit
    // Clear PG bit - Hover: see bit 0 cleared
    flash_cr &= ~(1U << 0);

    // Lock flash - Hover: see bit 31 set
    flash_cr |= (1U << 31);
}

// ============================================================================
// Example 10: Bit Manipulation Tricks
// ============================================================================

void bit_tricks(void)
{
    uint32_t value = 0x00001234;

    // Set a specific bit (bit 7) - Hover: 0x1234 -> 0x1234 | 0x80 = 0x12B4
    value |= (1U << 7);

    // Clear a specific bit (bit 4) - Hover: 0x12B4 -> 0x12A4
    value &= ~(1U << 4);

    // Toggle a specific bit (bit 5) - Hover: 0x12A4 -> 0x1284 or 0x12C4
    value ^= (1U << 5);

    // Check if bit is set
    uint32_t bit_8_is_set = (value & (1U << 8)) != 0;

    // Swap two bits (e.g., bit 0 and bit 7)
    uint32_t bit0 = (value >> 0) & 1;
    uint32_t bit7 = (value >> 7) & 1;
    if (bit0 != bit7) {
        value ^= (1U << 0) | (1U << 7);  // Hover to see XOR result
    }

    // Count set bits using bit manipulation
    uint32_t count = 0;
    uint32_t temp = value;
    while (temp) {
        temp &= (temp - 1);  // Hover: see bit clearing
        count++;
    }

    // Isolate rightmost 1-bit
    uint32_t rightmost = value & (-value);  // Hover to see result

    // Create bit mask
    uint32_t mask = (1U << 8) - 1;  // Hover: creates 0xFF

    // Align value to 4-byte boundary (clear lower 2 bits)
    uint32_t aligned = value & ~3U;  // Hover: see alignment
}

int main(void)
{
    printf("Bit Operation Hover Examples\n");
    printf("=================================\n\n");
    printf("SUPPORTED:\n");
    printf("  ✅ value |= 0x80 (variable & literal)\n");
    printf("  ✅ 1U << 5 (constant expressions)\n\n");
    printf("NOT SUPPORTED:\n");
    printf("  ❌ a ^ b (variable & variable)\n");
    printf("  ❌ value &= func() (function calls)\n\n");

    constant_expression_demo();
    unsupported_patterns_example();
    configure_gpio_pin();
    configure_spi();
    configure_timer();
    handle_interrupt_flags();
    bit_field_operations();
    power_management();
    configure_adc();
    configure_dma_stream();
    flash_memory_operation();
    bit_tricks();

    return 0;
}
