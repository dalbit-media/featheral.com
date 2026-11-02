declare module '*services/database/sqlite.js' {
  export interface SqliteStatement {
    all(...parameters: any[]): any[];
    get(...parameters: any[]): any;
    run(...parameters: any[]): { changes: number; lastInsertRowid: number | bigint };
  }

  export interface SqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): SqliteStatement;
    close(): void;
  };

  const sqlite: {
    open(file: string, options?: object): {
      exec(sql: string): void;
      prepare(sql: string): SqliteStatement;
      close(): void;
    };
  };

  export default sqlite;
}
