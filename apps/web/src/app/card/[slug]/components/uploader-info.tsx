'use client';

import Link from 'next/link';

interface UploaderInfoProps {
  uploader: {
    username: string;
    displayName: string | null;
  };
  createdAt: number;
}

export function UploaderInfo({ uploader, createdAt }: UploaderInfoProps) {
  const displayName = uploader.displayName || uploader.username;

  return (
    <div className="flex items-center gap-3 mt-4 text-sm text-starlight/60">
      <Link href={`/user/${uploader.username}`} className="w-8 h-8 rounded-full bg-nebula/20 flex items-center justify-center hover:bg-nebula/30 transition-colors">
        <span className="text-sm">{displayName[0].toUpperCase()}</span>
      </Link>
      <div>
        Uploaded by{' '}
        <Link href={`/user/${uploader.username}`} className="text-nebula hover:underline">
          {displayName}
        </Link>
        {' '}on {new Date(createdAt * 1000).toLocaleDateString()}
      </div>
    </div>
  );
}
