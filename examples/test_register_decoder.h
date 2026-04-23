#include <cstdint>

// Test file for register value decoder feature

// Simple UART control register
union UartCtrlReg {
    uint32_t dword;
    struct {
        uint32_t tx_en : 1;     // [0]   [RW][0x0] Transmit enable
        uint32_t rx_en : 1;     // [1]   [RW][0x0] Receive enable
        uint32_t parity_en : 1; // [2]   [RW][0x0] Parity enable
        uint32_t stop_bits : 2; // [4:3] [RW][0x0] Stop bits: 0=1bit, 1=1.5bits, 2=2bits
        uint32_t reserved1 : 3; // [7:5] [RO][0x0] Reserved
        uint32_t baud_sel : 4;  // [11:8][RW][0x0] Baud rate selector
        uint32_t reserved2 : 20;// [31:12][RO][0x0] Reserved
    } bits;
};

// Interrupt control register
union IrqCtrlReg {
    uint32_t dword;
    struct {
        uint32_t int0_set : 1;  // [0]   [RW1C][0x0] Interrupt 0 set
        uint32_t int1_set : 1;  // [1]   [RW1C][0x0] Interrupt 1 set
        uint32_t int2_set : 1;  // [2]   [RW1C][0x0] Interrupt 2 set
        uint32_t int3_set : 1;  // [3]   [RW1C][0x0] Interrupt 3 set
        uint32_t int4_set : 1;  // [4]   [RW1C][0x0] Interrupt 4 set
        uint32_t int5_set : 1;  // [5]   [RW1C][0x0] Interrupt 5 set
        uint32_t priority : 4;  // [9:6] [RW][0x7]  Interrupt priority
        uint32_t enable : 1;    // [10]  [RW][0x0]  Global interrupt enable
        uint32_t reserved : 21; // [31:11][RO][0x0] Reserved
    } bits;
};

// GPIO control register
union GpioCtrlReg {
    uint32_t dword;
    struct {
        uint32_t pin0_out : 1;  // [0]   [RW][0x0] Pin 0 output value
        uint32_t pin1_out : 1;  // [1]   [RW][0x0] Pin 1 output value
        uint32_t pin2_out : 1;  // [2]   [RW][0x0] Pin 2 output value
        uint32_t pin3_out : 1;  // [3]   [RW][0x0] Pin 3 output value
        uint32_t pin4_out : 1;  // [4]   [RW][0x0] Pin 4 output value
        uint32_t pin5_out : 1;  // [5]   [RW][0x0] Pin 5 output value
        uint32_t pin6_out : 1;  // [6]   [RW][0x0] Pin 6 output value
        uint32_t pin7_out : 1;  // [7]   [RW][0x0] Pin 7 output value
        uint32_t dir_mask : 8;  // [15:8][RW][0xFF] Direction mask (1=output, 0=input)
        uint32_t reserved : 16; // [31:16][RO][0x0] Reserved
    } bits;
};

void test_register_decoder() {
    // Hover over these register values to see decoded fields:

    // UART example: 0x30B = 0b0011_0000_1011
    // Should decode to:
    //   TX_EN = 1, RX_EN = 1, PARITY_EN = 0
    //   STOP_BITS = 1, BAUD_SEL = 3
    UartCtrlReg uart_ctrl;
    uart_ctrl.dword = 0x30B;

    // IRQ example: 0x1E1 = 0b0001_1110_0001
    // Should decode to:
    //   int0_set = 1, int1-4_set = 0, int5_set = 1
    //   priority = 7, enable = 1
    IrqCtrlReg irq_ctrl;
    irq_ctrl.dword = 0x1E1;

    // GPIO example: 0x55AA = 0b0101_0101_1010_1010
    // Should decode to:
    //   pin0_out = 0, pin1_out = 1, pin2_out = 0, pin3_out = 1...
    //   dir_mask = 0x55
    GpioCtrlReg gpio_ctrl;
    gpio_ctrl.dword = 0x55AA;

    // Simple assignment - hover over the value
    UartCtrlReg uart2;
    uart2.dword = 0x07;  // TX_EN=1, RX_EN=1, PARITY_EN=1

    // Hex value
    IrqCtrlReg irq2;
    irq2.dword = 0xFF;    // All interrupt bits set

    // Binary value
    GpioCtrlReg gpio2;
    gpio2.dword = 0b11111111;  // All pins high
}
