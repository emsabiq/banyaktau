import PImage from 'pureimage';
import fsSync from 'fs';
import path from 'path';

const fontPath = 'public/assets/fonts/PlusJakartaSans-Bold.ttf';
console.log('Font exists:', fsSync.existsSync(fontPath));

try {
  const font = PImage.registerFont(fontPath, 'TestJakarta');
  console.log('registerFont returned:', typeof font);
  if (typeof font.loadSync === 'function') {
    font.loadSync();
    console.log('loadSync succeeded');
  } else if (typeof font.load === 'function') {
    await new Promise((res, rej) => font.load(res));
    console.log('load succeeded');
  }
} catch (e) {
  console.error('Error loading font:', e);
}
