// The SDK names the Fetch headers union globally. Node 22 exposes it through RequestInit.
type HeadersInit = NonNullable<RequestInit['headers']>;
