//! Signing for tests: the control plane signs bindings in production; tests need a local signer.

use base64::Engine as _;
use nest_protocol::gateway::{BINDING_PREFIX, BindingClaims, signing_message};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};

/// An ECDSA P-256 key pair that signs bindings the gateway accepts once its public key is
/// installed with `State::set_key(signer.kid(), &signer.public_key())`.
pub struct Signer {
    key: EcdsaKeyPair,
    rng: SystemRandom,
}

impl Signer {
    pub fn generate() -> Signer {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).expect("keygen");
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).expect("key");
        Signer { key, rng }
    }

    /// The raw uncompressed SEC1 point (65 bytes).
    pub fn public_key(&self) -> Vec<u8> {
        self.key.public_key().as_ref().to_vec()
    }

    /// First 16 hex characters of SHA-256 over the raw public key, as the control plane computes it.
    pub fn kid(&self) -> String {
        kid_of(&self.public_key())
    }

    /// Sign claims exactly as serialized here: `nbd_<claims>.<r‖s>`.
    pub fn sign(&self, claims: &BindingClaims) -> String {
        let claims_json = serde_json::to_vec(claims).expect("claims serialize");
        let claims_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&claims_json);
        let sig = self.key.sign(&self.rng, &signing_message(&claims_b64)).expect("sign");
        format!("{BINDING_PREFIX}{claims_b64}.{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.as_ref()))
    }
}

pub fn kid_of(public_key: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, public_key);
    digest.as_ref().iter().take(8).map(|b| format!("{b:02x}")).collect()
}
