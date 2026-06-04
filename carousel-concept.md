# Konsep Carousel untuk BanyakTau

## Tujuan

Membuat konsep tambahan untuk menghasilkan versi carousel dari konten yang saat ini dibuat per scene. Carousel ini akan:

- Slide 1: judul + hook / arahan masuk
- Slide tengah: penjelasan berurutan, setiap slide memberi arahan ke slide berikutnya
- Slide terakhir: simpulan natural dan panggilan penutup
- Menjaga gaya edukasi BanyakTau: ringkas, faktual, visual-friendly, tanpa teks pada gambar

## Prinsip utama

1. Tetap pertahankan alur cerita utuh.
2. Setiap slide punya fokus dan transisi jelas ke slide berikut.
3. Slide pertama berfungsi sebagai "pembuka" bukan hanya judul statis.
4. Slide terakhir memberi penutup, bukan label "kesimpulan".
5. Konsep ini dibuat sebagai fitur tambahan, bukan menggantikan alur scene lama.

## Struktur data yang diusulkan

Carousel disimpan terpisah dari `plan.scenes`:

```json
{
  "carousel": {
    "title": "Kenapa tutup botol plastik punya segel?",
    "slides": [
      {
        "index": 1,
        "type": "title",
        "screenText": "Kenapa tutup botol plastik selalu tersegel?",
        "narration": "Ternyata segel kecil itu bukan sekadar kertas—itu bagian penting dari keamanan air minum.",
        "nextHint": "Lihat slide berikutnya untuk tahu fungsinya",
        "imagePrompt": "clean educational illustration of a plastic bottle cap with safety seal, close-up, no text"
      },
      {
        "index": 2,
        "type": "content",
        "screenText": "Segel memberi tanda kalau botol belum dibuka",
        "narration": "Segel kertas atau plastik memberi tanda visual bahwa produk masih asli dan belum disentuh.",
        "nextHint": "Lanjut ke mekanisme segelnya",
        "imagePrompt": "illustration of a bottle cap safety seal being inspected, product packaging context"
      },
      {
        "index": 3,
        "type": "conclusion",
        "screenText": "Jadi, segel bukan cuma dekorasi",
        "narration": "Itu adalah perlindungan kecil yang menjaga kualitas dan memberi rasa tenang saat kita minum.",
        "imagePrompt": "soft documentary style image of bottled drinks on shelf, safety seal visible"
      }
    ]
  }
}
```

## Konversi dari scene ke carousel

- Slide 1: gunakan `item.plan.title` dan `item.plan.hook` sebagai judul/pembuka.
- Slide 2..N-1: ekstrak setiap `scene` menjadi satu slide pendek dengan:
  - `screenText` ringkas
  - `narration` singkat dari scene
  - `nextHint` yang mengarah ke slide berikut
- Slide terakhir: gunakan `item.plan.summary` atau ringkasan penutup dari scene terakhir sebagai simpulan.

## Mengapa ini aman untuk implementasi lokal

- Tidak perlu mengubah `src/` yang ada.
- Bisa dibuat sebagai modul baru `src/carousel-concept.js`.
- Fitur lama tetap menggunakan `plan.scenes` dan pipeline video yang ada.
- Carousel baru bisa dipanggil secara eksplisit saat dibutuhkan.

## Langkah selanjutnya

1. Buat modul konversi carousel baru di `src/carousel-concept.js`.
2. Rancang prompt AI untuk menghasilkan slide dengan `nextHint`.
3. Uji dengan data dummy dari output `createKnowledgeDraft`.
4. Jika cocok, integrasikan opsi baru tanpa mengubah alur scene lama.
