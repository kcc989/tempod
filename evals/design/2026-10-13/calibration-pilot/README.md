# Calibration evidence

See report.md for the failed calibration and remaining scope. Raw model answers and metadata are saved per run. Images and context are unchanged within each comparison.

Each request-summary.json preserves model, state and questions. Its images are file references with hashes. Reconstruct an image object by base64-encoding those exact bytes and using the recorded content_type. originalRequestSha256 refers to the original compact JSON body retained locally in request.json; formatting differences in reconstructed JSON can change the request hash without changing input values.

The original request.json files contain repeated base64 image data. They remain saved locally but are omitted from this evidence commit to avoid duplicating image bytes. Request summaries, exact images and all returned answers are committed.
