# Eye Contracts

Input validation and enumerations for the Halunasu ophthalmology EMR.

Every exam value is stored per eye (`od` = right, `os` = left). The package
validates structure only; calculations, diffs, and trends live in `eye-core`.
