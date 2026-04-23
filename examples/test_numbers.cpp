// Test file for number base conversion hover feature

int main() {
    // Hexadecimal with 0x prefix
    int hex1 = 0xFF;
    int hex2 = 0x1234;
    int hex3 = 0xABCD;
    int hex4 = 0xDEADBEEF;

    // More hexadecimal values
    int hexMore1 = 0xBEEF;
    int hexMore2 = 0xCAFE;

    // Binary with 0b prefix
    int bin1 = 0b1010;
    int bin2 = 0b11111111;
    int bin3 = 0b10101010;

    // Decimal numbers
    int dec1 = 255;
    int dec2 = 1024;
    int dec3 = 65535;

    // Numbers with digit separators (C++14)
    int sep1 = 1'000'000;
    int sep2 = 0xFF'FF'FF;
    int sep3 = 0b1111'0000'1111'0000;

    // Test bit positions
    int bits1 = 0x00000001;  // Bit 0
    int bits2 = 0x00000080;  // Bit 7
    int bits3 = 0x80000000;  // Bit 31
    int bits4 = 0x00FF00FF;  // Multiple bits set

    return 0;
}
