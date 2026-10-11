use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

/// `<name>`, `<name>.1` … `<name>.<files - 1>`; each holds at most `max_bytes` (a single longer
/// line still gets its own file).
pub struct RotatingFile {
    dir: PathBuf,
    name: String,
    max_bytes: u64,
    files: usize,
    file: Option<File>,
    size: u64,
}

impl RotatingFile {
    pub fn open(dir: &Path, name: &str, max_bytes: u64, files: usize) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let mut this = Self {
            dir: dir.to_path_buf(),
            name: name.to_string(),
            max_bytes,
            files: files.max(1),
            file: None,
            size: 0,
        };
        this.open_current()?;
        Ok(this)
    }

    /// The file at `index`: 0 is the current one, higher is older.
    pub fn path(&self, index: usize) -> PathBuf {
        if index == 0 {
            self.dir.join(&self.name)
        } else {
            self.dir.join(format!("{}.{index}", self.name))
        }
    }

    pub fn write_line(&mut self, line: &str) -> io::Result<()> {
        let len = line.len() as u64 + 1;
        if self.size > 0 && self.size + len > self.max_bytes {
            self.rotate()?;
        }
        if self.file.is_none() {
            self.open_current()?;
        }
        let file = self.file.as_mut().ok_or(io::ErrorKind::NotFound)?;
        let mut buf = Vec::with_capacity(line.len() + 1);
        buf.extend_from_slice(line.as_bytes());
        buf.push(b'\n');
        file.write_all(&buf)?;
        self.size += len;
        Ok(())
    }

    pub fn sync(&mut self) -> io::Result<()> {
        match &mut self.file {
            Some(f) => f.sync_data(),
            None => Ok(()),
        }
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file = None;
        if self.files == 1 {
            let _ = fs::remove_file(self.path(0));
        }
        for i in (1..self.files).rev() {
            let from = self.path(i - 1);
            if from.exists() {
                fs::rename(&from, self.path(i))?;
            }
        }
        self.open_current()
    }

    fn open_current(&mut self) -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let file = options.open(self.path(0))?;
        self.size = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::write_atomic;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tempo-mac-log-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rotates_at_the_size_limit_and_keeps_five_files() {
        let dir = temp_dir("rotate");
        let mut log = RotatingFile::open(&dir, "tempo.log", 20, 5).unwrap();
        for i in 0..14 {
            log.write_line(&format!("line-{i:03}")).unwrap();
        }
        let read = |p: PathBuf| fs::read_to_string(p).unwrap();
        assert_eq!(read(log.path(0)), "line-012\nline-013\n");
        assert_eq!(read(log.path(1)), "line-010\nline-011\n");
        assert_eq!(read(log.path(4)), "line-004\nline-005\n");
        assert!(!log.path(5).exists());
        let mut names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "tempo.log",
                "tempo.log.1",
                "tempo.log.2",
                "tempo.log.3",
                "tempo.log.4"
            ]
        );
        for i in 0..5 {
            assert!(fs::metadata(log.path(i)).unwrap().len() <= 20);
        }
    }

    #[test]
    fn a_line_that_fits_exactly_does_not_rotate() {
        let dir = temp_dir("exact");
        let mut log = RotatingFile::open(&dir, "tempo.log", 18, 5).unwrap();
        log.write_line("12345678").unwrap();
        log.write_line("abcdefgh").unwrap();
        assert!(!log.path(1).exists());
        log.write_line("x").unwrap();
        assert_eq!(
            fs::read_to_string(log.path(1)).unwrap(),
            "12345678\nabcdefgh\n"
        );
        assert_eq!(fs::read_to_string(log.path(0)).unwrap(), "x\n");
    }

    #[test]
    fn reopening_continues_the_current_file_size() {
        let dir = temp_dir("reopen");
        write_atomic(&dir.join("tempo.log"), b"0123456789012345\n").unwrap();
        let mut log = RotatingFile::open(&dir, "tempo.log", 20, 5).unwrap();
        log.write_line("next").unwrap();
        assert_eq!(fs::read_to_string(log.path(0)).unwrap(), "next\n");
        assert_eq!(
            fs::read_to_string(log.path(1)).unwrap(),
            "0123456789012345\n"
        );
    }

    #[test]
    fn an_oversized_line_gets_its_own_file() {
        let dir = temp_dir("oversized");
        let mut log = RotatingFile::open(&dir, "tempo.log", 10, 5).unwrap();
        log.write_line("a").unwrap();
        log.write_line("this line is longer than ten").unwrap();
        log.write_line("b").unwrap();
        assert_eq!(fs::read_to_string(log.path(2)).unwrap(), "a\n");
        assert_eq!(
            fs::read_to_string(log.path(1)).unwrap(),
            "this line is longer than ten\n"
        );
        assert_eq!(fs::read_to_string(log.path(0)).unwrap(), "b\n");
    }
}
