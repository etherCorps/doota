export type DiceBearOptions = {
	seed: string;
	style?: 'thumbs' | 'bottts-neutral';
	format?: 'svg' | 'png';
	scale?: string;
};

export function getDiceBearURL({ seed, scale, format = 'png', style = 'thumbs' }: DiceBearOptions) {
	const diceURL = new URL(`https://api.dicebear.com/9.x/${style}/${format}`);
	diceURL.searchParams.append('seed', seed);
	if (scale) {
		diceURL.searchParams.append('scale', scale);
	}
	return diceURL.toString();
}
