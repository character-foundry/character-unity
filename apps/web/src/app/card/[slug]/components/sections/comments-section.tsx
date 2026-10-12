'use client';

interface CommentsSectionProps {
  cardId: string;
  commentsCount: number;
}

export function CommentsSection({ commentsCount }: CommentsSectionProps) {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold gradient-text">
        Comments ({commentsCount})
      </h2>

      <div className="bg-cosmic-teal/20 rounded-lg p-6 text-center">
        <svg className="w-12 h-12 mx-auto mb-4 text-starlight/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        <p className="text-starlight/50 italic">
          Comments coming soon. Login to be notified when this feature launches.
        </p>
      </div>
    </div>
  );
}
