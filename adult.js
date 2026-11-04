// parser.js - Xtream API Parser mit Kategorien + Genres
export class XtreamParser {
  constructor(server, username, password) {
    this.server = server.replace(/\/$/, '');
    this.username = username;
    this.password = password;
  }

  async api(action, extra = '') {
    const url = `${this.server}/player_api.php?username=${this.username}&password=${this.password}&action=${action}${extra}`;
    const res = await fetch(url);
    return await res.json();
  }

  // === KATEGORIEN ===
  async getAllCategories() {
    const [live, vod, series] = await Promise.all([
      this.api('get_live_categories'),
      this.api('get_vod_categories'),
      this.api('get_series_categories')
    ]);
    return { live, vod, series };
  }

  isAdult(name) {
    const n = (name || '').toLowerCase();
    return n.includes('adult') || n.includes('xxx') || n.includes('18+') || n.includes('porn');
  }

  // === GENRES ===
  // Genres aus VOD / Series Details auslesen und sammeln
  async getAllGenres() {
    const genres = new Set();

    // VOD Genres
    const vodCats = await this.api('get_vod_categories');
    for (const cat of vodCats.slice(0, 5)) { // nur erste 5 Kategorien zum Testen, sonst zu langsam
      const streams = await this.api('get_vod_streams', `&category_id=${cat.category_id}`);
      for (const s of streams.slice(0, 10)) {
        const info = await this.api('get_vod_info', `&vod_id=${s.stream_id}`);
        if (info?.info?.genre) {
          info.info.genre.split(',').forEach(g => genres.add(g.trim()));
        }
        if (info?.info?.category_id) {
          // Kategorie auch als Genre speichern
        }
      }
    }
    return [...genres]; // z.B. ["Action", "Comedy", "Drama", "Horror"]
  }

  // Adult mit Kategorien + Genres
  async getAdultContent() {
    const { live, vod, series } = await this.getAllCategories();
    let result = [];
    let allGenres = new Set();

    // VOD Adult
    const vodAdultCats = vod.filter(c => this.isAdult(c.category_name));
    for (const cat of vodAdultCats) {
      const streams = await this.api('get_vod_streams', `&category_id=${cat.category_id}`);
      for (const s of streams) {
        // Genre für diesen Film holen
        let genre = '';
        try {
          const info = await this.api('get_vod_info', `&vod_id=${s.stream_id}`);
          genre = info?.info?.genre || '';
          genre.split(',').forEach(g => { if(g.trim()) allGenres.add(g.trim()) });
        } catch(e) {}

        result.push({
          type: 'vod',
          category: cat.category_name,
          category_id: cat.category_id,
          genre: genre, // z.B. "Action, Drama"
          genres: genre.split(',').map(g => g.trim()).filter(Boolean),
          id: s.stream_id,
          name: s.name,
          poster: s.stream_icon,
          rating: s.rating,
          url: `${this.server}/movie/${this.username}/${this.password}/${s.stream_id}.${s.container_extension || 'mp4'}`,
          isAdult: true
        });
      }
    }

    // Live Adult
    const liveAdultCats = live.filter(c => this.isAdult(c.category_name));
    for (const cat of liveAdultCats) {
      const streams = await this.api('get_live_streams', `&category_id=${cat.category_id}`);
      streams.forEach(s => {
        result.push({
          type: 'live',
          category: cat.category_name,
          category_id: cat.category_id,
          genre: cat.category_name,
          genres: [cat.category_name],
          id: s.stream_id,
          name: s.name,
          poster: s.stream_icon,
          url: `${this.server}/live/${this.username}/${this.password}/${s.stream_id}.ts`,
          isAdult: true
        });
      });
    }

    // Series Adult
    const seriesAdultCats = series.filter(c => this.isAdult(c.category_name));
    for (const cat of seriesAdultCats) {
      const streams = await this.api('get_series', `&category_id=${cat.category_id}`);
      for (const s of streams) {
        let genre = '';
        try {
          const info = await this.api('get_series_info', `&series_id=${s.series_id}`);
          genre = info?.info?.genre || '';
          genre.split(',').forEach(g => { if(g.trim()) allGenres.add(g.trim()) });
        } catch(e) {}

        result.push({
          type: 'series',
          category: cat.category_name,
          category_id: cat.category_id,
          genre: genre,
          genres: genre.split(',').map(g => g.trim()).filter(Boolean),
          id: s.series_id,
          name: s.name,
          poster: s.cover,
          isAdult: true
        });
      }
    }

    return {
      items: result,
      categories: {
        live: liveAdultCats,
        vod: vodAdultCats,
        series: seriesAdultCats
      },
      genres: [...allGenres] // alle Genres die gefunden wurden
    };
  }

  // Normale Kategorien ohne Adult
  async getCleanCategories() {
    const { live, vod, series } = await this.getAllCategories();
    return {
      live: live.filter(c => !this.isAdult(c.category_name)),
      vod: vod.filter(c => !this.isAdult(c.category_name)),
      series: series.filter(c => !this.isAdult(c.category_name)),
    };
  }
}

// Nutzung:
// const parser = new XtreamParser('http://server:8080', 'user', 'pass');
// const adult = await parser.getAdultContent();
// console.log(adult.categories); // Kategorien
// console.log(adult.genres); // Genres z.B. ["Action", "Comedy"]
// console.log(adult.items); // Alle Filme mit category + genre
