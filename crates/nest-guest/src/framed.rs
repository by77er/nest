//! Error bodies for the guest's replies over [`nest_protocol::guest::framed`].

use nest_protocol::guest::error_code;
use nest_protocol::guest::frame::{Frame, Kind};
use nest_protocol::model::ErrorBody;
use serde::de::DeserializeOwned;

/// Decode a JSON frame into `T`, mapping failures to a `bad_request` error body.
pub fn parse_json<T: DeserializeOwned>(f: &Frame) -> Result<T, ErrorBody> {
    if f.kind != Kind::Json {
        return Err(bad_request("expected a JSON frame"));
    }
    serde_json::from_slice(&f.payload).map_err(|e| bad_request(&format!("invalid message: {e}")))
}

pub fn err(code: &str, message: impl Into<String>, retryable: bool) -> ErrorBody {
    ErrorBody { code: code.to_string(), message: message.into(), retryable }
}

pub fn bad_request(message: &str) -> ErrorBody {
    err(error_code::BAD_REQUEST, message, false)
}
