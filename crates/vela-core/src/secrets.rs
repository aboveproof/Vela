use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use crate::error::{VelaError, VelaResult};

const SERVICE_NAME: &str = "dev.vela.ssh";

pub trait SecretStore: Send + Sync {
    fn get_secret(&self, key: &str) -> VelaResult<Option<String>>;
    fn set_secret(&self, key: &str, value: &str) -> VelaResult<()>;
    fn delete_secret(&self, key: &str) -> VelaResult<()>;
}

/// OS-backed credential store (Windows Credential Manager, macOS Keychain, Linux Secret Service).
#[derive(Debug, Default, Clone)]
pub struct OsKeyringStore;

impl SecretStore for OsKeyringStore {
    fn get_secret(&self, key: &str) -> VelaResult<Option<String>> {
        let entry = keyring::Entry::new(SERVICE_NAME, key)
            .map_err(|err| VelaError::Keychain(err.to_string()))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(VelaError::Keychain(err.to_string())),
        }
    }

    fn set_secret(&self, key: &str, value: &str) -> VelaResult<()> {
        let entry = keyring::Entry::new(SERVICE_NAME, key)
            .map_err(|err| VelaError::Keychain(err.to_string()))?;
        entry
            .set_password(value)
            .map_err(|err| VelaError::Keychain(err.to_string()))
    }

    fn delete_secret(&self, key: &str) -> VelaResult<()> {
        let entry = keyring::Entry::new(SERVICE_NAME, key)
            .map_err(|err| VelaError::Keychain(err.to_string()))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(VelaError::Keychain(err.to_string())),
        }
    }
}

/// In-memory secret store for tests and fallback environments.
#[derive(Debug, Default, Clone)]
pub struct MemorySecretStore {
    inner: Arc<RwLock<HashMap<String, String>>>,
}

impl SecretStore for MemorySecretStore {
    fn get_secret(&self, key: &str) -> VelaResult<Option<String>> {
        let guard = self
            .inner
            .read()
            .map_err(|err| VelaError::Keychain(format!("lock poisoned: {err}")))?;
        Ok(guard.get(key).cloned())
    }

    fn set_secret(&self, key: &str, value: &str) -> VelaResult<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|err| VelaError::Keychain(format!("lock poisoned: {err}")))?;
        guard.insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete_secret(&self, key: &str) -> VelaResult<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|err| VelaError::Keychain(format!("lock poisoned: {err}")))?;
        guard.remove(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_secret_store_crud() -> Result<(), Box<dyn std::error::Error>> {
        let store = MemorySecretStore::default();
        assert_eq!(store.get_secret("host:1")?, None);
        store.set_secret("host:1", "hunter2")?;
        assert_eq!(store.get_secret("host:1")?.as_deref(), Some("hunter2"));
        store.delete_secret("host:1")?;
        assert_eq!(store.get_secret("host:1")?, None);
        Ok(())
    }
}
