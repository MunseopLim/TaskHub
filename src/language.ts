export type Translate = (ko: string, en: string) => string;

export function translator(locale: () => string): Translate {
    return (ko, en) => locale().toLowerCase().startsWith('ko') ? ko : en;
}
