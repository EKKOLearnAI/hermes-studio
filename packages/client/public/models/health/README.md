# Health 3D Anatomy Assets

This directory contains the redistributable 3D anatomy assets used by the health body-map viewer.

## Source

- Dataset: BodyParts3D
- Mirror used for retrieval: `https://github.com/Kevin-Mattheus-Moerman/BodyParts3D`
- Original project: `http://lifesciencedb.jp/bp3d/`

## License

The anatomical STL files in `bodyparts3d/` are derived from the BodyParts3D dataset and follow the attribution requirements documented by the upstream mirror and original archive:

`BodyParts3D, (c) The Database Center for Life Science licensed under CC Attribution-Share Alike 2.1 Japan`

See [LICENSE.txt](/d:/code/my_project/personal-assistant/frontend-next/public/models/health/LICENSE.txt) in this directory for the local copy used by this project.

## Notes

- The viewer maps these files to app-level body regions in `frontend-next/components/health/health-3d-model-mapping.ts`.
- We intentionally ship only the subset needed for the health page instead of the entire dataset.
