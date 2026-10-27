// Offline storage on the tablet (IndexedDB).
//   jobs      one entry per job: the field pack and when it was loaded
//   records   field data per tree, key [jobId, treeKey]
//   photos    compressed JPEG photos, key "<jobId>|<treeKey>|<kind>"
//   settings  small values such as the surveyor's name

const DB_NAME = "treefield";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("jobs", { keyPath: "id" });
        db.createObjectStore("records", { keyPath: ["jobId", "key"] }).createIndex("job", "jobId");
        db.createObjectStore("photos", { keyPath: "id" }).createIndex("job", "jobId");
        db.createObjectStore("settings");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = "readonly") {
  return (await open()).transaction(name, mode).objectStore(name);
}

async function finished(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const db = {
  async listJobs() {
    return done((await store("jobs")).getAll());
  },
  async getJob(id) {
    return done((await store("jobs")).get(id));
  },
  async putJob(job) {
    return done((await store("jobs", "readwrite")).put(job));
  },
  async deleteJob(id) {
    const tx = (await open()).transaction(["jobs", "records", "photos"], "readwrite");
    tx.objectStore("jobs").delete(id);
    for (const name of ["records", "photos"]) {
      const index = tx.objectStore(name).index("job");
      index.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          tx.objectStore(name).delete(cursor.primaryKey);
          cursor.continue();
        }
      };
    }
    return finished(tx);
  },

  async getRecords(jobId) {
    return done((await store("records")).index("job").getAll(IDBKeyRange.only(jobId)));
  },
  async putRecord(record) {
    return done((await store("records", "readwrite")).put(record));
  },
  async putRecords(records) {
    const tx = (await open()).transaction("records", "readwrite");
    for (const r of records) tx.objectStore("records").put(r);
    return finished(tx);
  },
  async deleteRecord(jobId, key) {
    return done((await store("records", "readwrite")).delete([jobId, key]));
  },

  async getPhoto(id) {
    return done((await store("photos")).get(id));
  },
  async putPhoto(photo) {
    return done((await store("photos", "readwrite")).put(photo));
  },
  async deletePhoto(id) {
    return done((await store("photos", "readwrite")).delete(id));
  },

  async getSetting(key, fallback = null) {
    const value = await done((await store("settings")).get(key));
    return value === undefined ? fallback : value;
  },
  async setSetting(key, value) {
    return done((await store("settings", "readwrite")).put(value, key));
  },
};
